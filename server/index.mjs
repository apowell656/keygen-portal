import { createServer } from "node:http"
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import nodemailer from "nodemailer"
import { createProvisionHandler } from "./provision.mjs"
import { createMailHandler } from "./mail.mjs"
const required = ["KEYGEN_BASE_URL", "KEYGEN_ACCOUNT_ID", "PORTAL_ORIGIN"]
for (const key of required) if (!process.env[key]) throw Error(`Missing ${key}`)
const baseUrl = new URL(process.env.KEYGEN_BASE_URL)
if (
  baseUrl.protocol !== "https:" ||
  baseUrl.pathname !== "/" ||
  baseUrl.username ||
  baseUrl.password
)
  throw Error("KEYGEN_BASE_URL must be an HTTPS origin")
const directory = process.env.MAIL_STATE_DIR || "/data"
await mkdir(directory, { recursive: true, mode: 0o700 })
const file = (key) =>
  `${directory}/${createHash("sha256").update(key).digest("hex")}.json`
const ledger = {
  async has(key) {
    try {
      const state = JSON.parse(await readFile(file(key), "utf8"))
      if (state.status === "sent") return true
      throw Object.assign(
        Error("Pending email requires manual delivery verification"),
        { code: "DELIVERY_PENDING" },
      )
    } catch (e) {
      if (e.code === "ENOENT") return false
      throw e
    }
  },
  async mark(key, status) {
    await writeFile(
      file(key),
      JSON.stringify({ status, at: new Date().toISOString() }),
      { mode: 0o600 },
    )
  },
  async remove(key) {
    await unlink(file(key))
  },
}
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  requireTLS: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
  logger: false,
  debug: false,
})
const handler = createMailHandler({
  config: {
    baseUrl: baseUrl.origin,
    account: process.env.KEYGEN_ACCOUNT_ID,
    origin: process.env.PORTAL_ORIGIN,
    version: process.env.KEYGEN_VERSION || "1.7",
    from: process.env.FROM_EMAIL,
    support: process.env.SUPPORT_EMAIL,
  },
  ledger,
  send: (message) => {
    if (
      ![
        "SMTP_HOST",
        "SMTP_USER",
        "SMTP_PASS",
        "FROM_EMAIL",
        "SUPPORT_EMAIL",
      ].every((key) => process.env[key])
    )
      throw Object.assign(Error("SMTP configuration missing"), {
        responseCode: 550,
      })
    return transport.sendMail(message)
  },
})
const provision = createProvisionHandler({
  config: {
    baseUrl: baseUrl.origin,
    account: process.env.KEYGEN_ACCOUNT_ID,
    origin: process.env.PORTAL_ORIGIN,
    version: process.env.KEYGEN_VERSION || "1.7",
  },
})
createServer(async (req, res) => {
  if (!["/api/promo/email", "/api/promo/keygen"].includes(req.url)) {
    res.writeHead(404)
    res.end()
    return
  }
  let text = ""
  for await (const chunk of req) {
    text += chunk
    if (text.length > 8192) {
      res.writeHead(413)
      res.end()
      return
    }
  }
  try {
    const response = await (
      req.url === "/api/promo/keygen" ? provision : handler
    )(
      new Request("http://localhost/api/promo/email", {
        method: req.method,
        headers: req.headers,
        ...(req.method !== "GET" && req.method !== "HEAD"
          ? { body: text }
          : {}),
      }),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(await response.text())
  } catch {
    res.writeHead(500)
    res.end()
  }
}).listen(Number(process.env.PORT || 8081), "0.0.0.0")
