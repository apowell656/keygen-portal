// Protected transport for the Portal's existing API utilities, never a general proxy.
export function createProvisionHandler({ config, apiFetch = fetch }) {
  const locks = new Set()
  return async (request) => {
    const respond = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      })
    if (
      request.method !== "POST" ||
      request.headers.get("Origin") !== config.origin
    )
      return respond(403, { error: "Origin or method rejected" })
    const authorization = request.headers.get("Authorization")
    if (!/^Bearer \S+$/.test(authorization || ""))
      return respond(401, { error: "Authentication required" })
    let payload
    try {
      const text = await request.text()
      if (text.length > 8192) throw Error()
      payload = JSON.parse(text)
    } catch {
      return respond(400, { error: "Invalid request" })
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return respond(400, { error: "Invalid request" })
    const { endpoint, method, body } = payload
    const root = `/accounts/${encodeURIComponent(config.account)}`
    if (typeof endpoint !== "string" || !endpoint.startsWith(root + "/"))
      return respond(400, { error: "Account mismatch" })
    const path = endpoint.slice(root.length)
    const idPattern = "[a-fA-F0-9-]{36}"
    const allowed =
      (method === "GET" &&
        (/^\/users\/[^/?#]+$/.test(path) ||
          new RegExp(`^/policies/${idPattern}$`).test(path))) ||
      (method === "POST" && ["/users", "/licenses"].includes(path)) ||
      (method === "PUT" &&
        new RegExp(`^/licenses/${idPattern}/owner$`).test(path))
    if (!allowed) return respond(400, { error: "Operation rejected" })
    if (path.startsWith("/users/")) {
      let identifier
      try {
        identifier = decodeURIComponent(path.slice(7))
      } catch {
        return respond(400, { error: "Invalid user identifier" })
      }
      if (/[/\\?#]/.test(identifier) || [".", ".."].includes(identifier))
        return respond(400, { error: "Invalid user identifier" })
    }
    const environment = request.headers.get("Keygen-Environment")
    if (environment && !/^[\w-]{1,128}$/.test(environment))
      return respond(400, { error: "Invalid environment" })
    const headers = {
      Authorization: authorization,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      "Keygen-Version": config.version,
      ...(environment ? { "Keygen-Environment": environment } : {}),
    }
    const globalHeaders = { ...headers }
    delete globalHeaders["Keygen-Environment"]
    const call = (path, options = {}, global = false) =>
      apiFetch(config.baseUrl + "/v1" + root + path, {
        headers: global ? globalHeaders : headers,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        ...options,
      })
    let key
    let locked = false
    try {
      const meResponse = await call("/me", {}, true)
      const me = (await meResponse.json()).data
      if (
        !meResponse.ok ||
        me?.type !== "users" ||
        me.attributes.role !== "admin"
      )
        return respond(403, { error: "Administrator required" })
      if (method !== "GET") {
        if (path === "/users") {
          const a = body?.data?.attributes
          const validName = (v) =>
            typeof v === "string" && v.trim().length > 0 && v.length <= 100
          if (
            !a ||
            !validName(a.firstName) ||
            typeof a.email !== "string" ||
            a.email.length > 254 ||
            (a.lastName != null &&
              (typeof a.lastName !== "string" || a.lastName.length > 100))
          )
            return respond(400, { error: "Invalid recipient fields" })
          if (
            body?.data?.type !== "users" ||
            !a ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email || "") ||
            !a.firstName ||
            Object.keys(a).some(
              (k) => !["email", "firstName", "lastName"].includes(k),
            ) ||
            Object.keys(body.data).some(
              (k) => !["type", "attributes"].includes(k),
            )
          )
            return respond(400, { error: "Invalid promotional recipient" })
        } else if (path === "/licenses") {
          const a = body?.data?.attributes,
            m = a?.metadata
          if (
            body?.data?.type !== "licenses" ||
            !a?.name ||
            !m ||
            m.promo !== true ||
            !m.reason ||
            !m.recipientFirstName ||
            !m.recipientEmail ||
            !body.data.relationships?.policy?.data?.id
          )
            return respond(400, { error: "Invalid promotional license" })
          const fields = [
            "app",
            "promoType",
            "recipientEmail",
            "recipientFirstName",
            "recipientLastName",
            "reason",
          ]
          if (
            fields.some((k) => typeof m[k] !== "string" || m[k].length > 255) ||
            !m.reason.trim() ||
            !m.recipientFirstName.trim() ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.recipientEmail) ||
            Object.keys(m).some(
              (k) => ![...fields, "promo", "marketingProductName"].includes(k),
            ) ||
            Object.keys(a).some((k) => !["name", "metadata"].includes(k)) ||
            Object.keys(body.data.relationships).some((k) => k !== "policy") ||
            body.data.relationships.policy.data.type !== "policies" ||
            !new RegExp(`^${idPattern}$`).test(
              body.data.relationships.policy.data.id,
            )
          )
            return respond(400, {
              error: "Invalid promotional metadata or policy",
            })
          if (
            m.marketingProductName !== undefined &&
            (typeof m.marketingProductName !== "string" ||
              !m.marketingProductName.trim() ||
              m.marketingProductName.length > 255 ||
              /[\r\n]/.test(m.marketingProductName))
          )
            return respond(400, { error: "Invalid marketing product name" })
          // Tie metadata to the chosen policy's product; Keygen still enforces permission and constraints.
          const policyResponse = await call(
            `/policies/${encodeURIComponent(body.data.relationships.policy.data.id)}`,
          )
          const policy = (await policyResponse.json()).data
          if (!policyResponse.ok || !policy)
            return respond(403, { error: "Policy rejected" })
          const productResponse = await call(
            `/products/${encodeURIComponent(policy.relationships.product.data.id)}`,
          )
          const product = (await productResponse.json()).data
          if (
            !productResponse.ok ||
            m.app !== (product.attributes.code || product.id)
          )
            return respond(400, { error: "Product metadata mismatch" })
        } else {
          if (
            body?.data?.type !== "users" ||
            !new RegExp(`^${idPattern}$`).test(body.data.id)
          )
            return respond(400, { error: "Owner required" })
          const licenseResponse = await call(path.replace("/owner", ""))
          const license = (await licenseResponse.json()).data
          if (
            !licenseResponse.ok ||
            license?.attributes.metadata?.promo !== true
          )
            return respond(400, { error: "Promotional license required" })
          const ownerResponse = await call(`/users/${body.data.id}`)
          const owner = (await ownerResponse.json()).data
          if (
            !ownerResponse.ok ||
            owner?.attributes.email.toLowerCase() !==
              String(license.attributes.metadata.recipientEmail).toLowerCase()
          )
            return respond(400, { error: "Recipient mismatch" })
        }
        key = `${me.id}:${environment || ""}:${path}`
        if (locks.has(key))
          return respond(409, { error: "Operation in progress" })
        locks.add(key)
        locked = true
      }
      const response = await call(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      // Return explicit Keygen failures as API envelopes, preserving existing utility behavior.
      const result = await response.json()
      if ((!response.ok && !result.errors) || (!result.data && !result.errors))
        return respond(502, { error: "Unconfirmed Keygen response" })
      return respond(200, result)
    } catch {
      return respond(502, {
        error:
          "Operation response unconfirmed; inspect existing records before retrying",
      })
    } finally {
      if (locked) locks.delete(key)
    }
  }
}
