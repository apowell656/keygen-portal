import { readFile } from "node:fs/promises"
const template = await readFile(
  new URL("../src/promo/email.html", import.meta.url),
  "utf8",
)
export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  )
export function renderMail(license, user, product, support) {
  const values = {
    PRODUCT_NAME: product.attributes.name,
    LICENSE_KEY: license.attributes.key,
    AMOUNT: "$0.00",
    ORDER_DATE: license.attributes.created,
    CUSTOMER_EMAIL: user.attributes.email,
    SUPPORT_EMAIL: support,
  }
  return {
    subject: `Your ${product.attributes.name.replace(/[\r\n]/g, "")} promotional license`,
    html: template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
      escapeHtml(values[key] ?? ""),
    ),
    text: `Hello ${user.attributes.firstName || ""},\n\nThank you for taking ${values.PRODUCT_NAME} for a spin.\n\nYour license key: ${values.LICENSE_KEY}\nLicense: ${license.attributes.name}\nIssued: ${values.ORDER_DATE}\nReason: ${license.attributes.metadata.reason}\nAmount: $0.00\nCustomer: ${values.CUSTOMER_EMAIL}\n\nOpen ${values.PRODUCT_NAME} and paste the license key during activation.\nIf you received this message in error, reply to this email.\nSupport: ${support}`,
  }
}
export function createMailHandler({ config, apiFetch = fetch, send, ledger }) {
  const locks = new Set()
  const rate = new Map()
  return async function handle(request) {
    const respond = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      })
    if (request.method !== "POST")
      return respond(405, { error: "POST required" })
    if (request.headers.get("Origin") !== config.origin)
      return respond(403, { error: "Origin rejected" })
    const authorization = request.headers.get("Authorization")
    if (!/^Bearer \S+$/.test(authorization || ""))
      return respond(401, { error: "Token authentication required" })
    let body
    try {
      const text = await request.text()
      if (text.length > 2048) throw Error()
      body = JSON.parse(text)
    } catch {
      return respond(400, { error: "Invalid request" })
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !/^[a-f0-9-]{36}$/i.test(body.licenseId || "") ||
      Object.keys(body).some((k) => k !== "licenseId")
    )
      return respond(400, { error: "License ID required" })
    const environment = request.headers.get("Keygen-Environment")
    if (environment && !/^[\w-]{1,128}$/.test(environment))
      return respond(400, { error: "Invalid environment" })
    const root = `${config.baseUrl}/v1/accounts/${encodeURIComponent(config.account)}`
    const api = async (path, global = false) => {
      const response = await apiFetch(root + path, {
        headers: {
          Authorization: authorization,
          Accept: "application/vnd.api+json",
          "Keygen-Version": config.version,
          ...(!global && environment
            ? { "Keygen-Environment": environment }
            : {}),
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      })
      if (!response.ok) throw Error("Keygen rejected request")
      const json = await response.json()
      if (!json.data) throw Error("Missing resource")
      return json.data
    }
    let key
    let locked = false
    try {
      const me = await api("/me", true)
      if (me.type !== "users" || me.attributes.role !== "admin")
        return respond(403, { error: "Administrator access required" })
      const permissions = me.attributes.permissions
      if (
        permissions &&
        !permissions.includes("*") &&
        !permissions.includes("license.read")
      )
        return respond(403, { error: "License read permission required" })
      const now = Date.now()
      for (const [id, entry] of rate) if (entry.until < now) rate.delete(id)
      const entry = rate.get(me.id) || { until: now + 60000, count: 0 }
      entry.count++
      rate.set(me.id, entry)
      if (entry.count > 10)
        return respond(429, { error: "Wait before sending more emails" })
      key = `${config.account}:${environment || "global"}:${body.licenseId}`
      if (locks.has(key))
        return respond(409, { error: "Delivery already in progress" })
      locks.add(key)
      locked = true
      if (await ledger.has(key)) return respond(200, { status: "sent" })
      const license = await api(`/licenses/${body.licenseId}`)
      const m = license.attributes.metadata
      const ownerId = license.relationships.owner?.data?.id
      if (m?.promo !== true || !ownerId || !license.attributes.key)
        return respond(400, { error: "Assigned promotional license required" })
      const user = await api(`/users/${encodeURIComponent(ownerId)}`)
      if (
        user.attributes.email.toLowerCase() !==
        String(m.recipientEmail).toLowerCase()
      )
        return respond(400, { error: "Recipient must match license owner" })
      const policy = await api(
        `/policies/${license.relationships.policy.data.id}`,
      )
      const product = await api(
        `/products/${policy.relationships.product.data.id}`,
      )
      // Mark before SMTP: ambiguous delivery must never silently send twice.
      await ledger.mark(key, "pending")
      try {
        await send({
          from: config.from,
          to: user.attributes.email,
          replyTo: config.support,
          ...renderMail(license, user, product, config.support),
        })
      } catch (error) {
        // Explicit SMTP rejection guarantees no acceptance. Network/timeouts are ambiguous.
        if (error.responseCode >= 400) {
          await ledger.remove(key)
          return respond(502, {
            error: "Email rejected; retry delivery using this license",
            status: "failed",
          })
        }
        return respond(502, {
          error:
            "Delivery could not be confirmed. Check SMTP delivery before clearing the pending record; do not resend automatically.",
          status: "uncertain",
        })
      }
      await ledger.mark(key, "sent")
      return respond(200, { status: "sent" })
    } catch (error) {
      if (error.code === "DELIVERY_PENDING")
        return respond(502, {
          status: "uncertain",
          error:
            "Previous email delivery is pending verification. Check SMTP delivery before clearing its marker and retrying.",
        })
      return respond(502, {
        error: "Delivery unavailable or Keygen authorization failed",
      })
    } finally {
      if (locked) locks.delete(key)
    }
  }
}
