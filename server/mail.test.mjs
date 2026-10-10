import { describe, it, expect, vi } from "vitest"
import { createMailHandler, renderMail } from "./mail.mjs"
import { createProvisionHandler } from "./provision.mjs"
const id = "11111111-1111-1111-1111-111111111111"
const config = {
  origin: "https://portal.example.com",
  baseUrl: "https://api.example.com",
  account: "account",
  version: "1.7",
  from: "licenses@example.com",
  support: "support@example.com",
}
function fixture(role = "admin") {
  const records = {
    "/me": { type: "users", id: "admin", attributes: { role } },
    [`/licenses/${id}`]: {
      id,
      attributes: {
        key: "KEY",
        name: "Promo",
        created: "2026-01-01",
        metadata: {
          promo: true,
          recipientEmail: "ada@example.com",
          reason: "Review",
        },
      },
      relationships: {
        owner: { data: { id: "user" } },
        policy: { data: { id: "policy" } },
      },
    },
    "/users": { type: "users", id: "user" },
    "/users/user": {
      attributes: { email: "ada@example.com", firstName: "Ada" },
    },
    "/policies/policy": {
      relationships: { product: { data: { id: "product" } } },
    },
    "/products/product": { attributes: { name: "Nimbus" } },
  }
  const apiFetch = vi.fn(
    async (url) =>
      new Response(
        JSON.stringify({
          data: records[
            new URL(url).pathname.replace("/v1/accounts/account", "")
          ],
        }),
        { status: 200 },
      ),
  )
  const states = new Map()
  const ledger = {
    has: vi.fn(async (key) => {
      if (states.get(key) === "pending") throw Error("Pending")
      return states.has(key)
    }),
    mark: vi.fn(async (key, state) => states.set(key, state)),
    remove: vi.fn(async (key) => states.delete(key)),
  }
  const send = vi.fn(async () => {})
  return {
    records,
    apiFetch,
    ledger,
    send,
    handler: createMailHandler({ config, apiFetch, ledger, send }),
  }
}
const request = (body = { licenseId: id }, headers = {}) =>
  new Request("https://portal.example.com/api/promo/email", {
    method: "POST",
    headers: {
      Origin: config.origin,
      Authorization: "Bearer TOKEN",
      ...headers,
    },
    body: JSON.stringify(body),
  })
describe("secure promo email", () => {
  it("rejects unauthenticated and nonadministrator callers", async () => {
    const f = fixture("user")
    expect((await f.handler(request({}, { Authorization: "" }))).status).toBe(
      401,
    )
    expect((await f.handler(request())).status).toBe(403)
    expect(f.send).not.toHaveBeenCalled()
  })
  it("rejects wrong origins and arbitrary recipients/content", async () => {
    const f = fixture()
    expect(
      (await f.handler(request({ licenseId: id, to: "other@example.com" })))
        .status,
    ).toBe(400)
    expect(
      (
        await f.handler(
          request({ licenseId: id }, { Origin: "https://evil.example.com" }),
        )
      ).status,
    ).toBe(403)
    f.records["/users/user"].attributes.email = "other@example.com"
    expect((await f.handler(request())).status).toBe(400)
    expect(f.send).not.toHaveBeenCalled()
  })
  it("sends approved HTML and text to the owner and deduplicates repeated delivery", async () => {
    const f = fixture()
    expect((await f.handler(request())).status).toBe(200)
    expect((await f.handler(request())).status).toBe(200)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        html: expect.stringContaining("Nimbus"),
        text: expect.stringContaining("KEY"),
      }),
    )
  })
  it("allows a retry after explicit SMTP rejection", async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce(
      Object.assign(Error("rejected"), { responseCode: 550 }),
    )
    expect((await f.handler(request())).status).toBe(502)
    expect((await f.handler(request())).status).toBe(200)
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it("blocks retries after ambiguous SMTP failures", async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce(Error("timeout"))
    expect((await f.handler(request())).status).toBe(502)
    expect((await f.handler(request())).status).toBe(502)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it("prevents simultaneous delivery without unlocking the active send", async () => {
    const f = fixture()
    let finish
    f.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = f.handler(request())
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1))
    expect((await f.handler(request())).status).toBe(409)
    expect((await f.handler(request())).status).toBe(409)
    finish()
    expect((await first).status).toBe(200)
  })
  it("escapes template variables while keeping plain text readable", () => {
    const f = fixture()
    f.records["/products/product"].attributes.name = "<b>Forge</b>"
    const m = renderMail(
      f.records[`/licenses/${id}`],
      f.records["/users/user"],
      f.records["/products/product"],
      config.support,
    )
    expect(m.html).toContain("&lt;b&gt;Forge&lt;/b&gt;")
    expect(m.text).toContain("<b>Forge</b>")
  })
})
describe("privileged provisioning transport", () => {
  it("rejects nonadministrators before forwarding writes", async () => {
    const f = fixture("user"),
      handler = createProvisionHandler({ config, apiFetch: f.apiFetch })
    const response = await handler(
      request({
        endpoint: "/accounts/account/users",
        method: "POST",
        body: {
          data: {
            type: "users",
            attributes: { email: "ada@example.com", firstName: "Ada" },
          },
        },
      }),
    )
    expect(response.status).toBe(403)
    expect(f.apiFetch).toHaveBeenCalledTimes(1)
  })
  it("rejects cross account paths and unapproved API actions", async () => {
    const f = fixture(),
      handler = createProvisionHandler({ config, apiFetch: f.apiFetch })
    for (const endpoint of [
      "/accounts/other/users",
      "/accounts/account/tokens",
      "/accounts/account/users/../../tokens",
    ])
      expect(
        (await handler(request({ endpoint, method: "POST" }))).status,
      ).toBe(400)
    expect(f.apiFetch).not.toHaveBeenCalled()
  })
  it("forwards allowed creation envelopes using the caller token", async () => {
    const f = fixture(),
      handler = createProvisionHandler({ config, apiFetch: f.apiFetch })
    const response = await handler(
      request({
        endpoint: "/accounts/account/users",
        method: "POST",
        body: {
          data: {
            type: "users",
            attributes: { email: "ada@example.com", firstName: "Ada" },
          },
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(f.apiFetch).toHaveBeenCalledTimes(2)
    expect(f.apiFetch.mock.calls[1][1].headers.Authorization).toBe(
      "Bearer TOKEN",
    )
  })
})

it("rejects null payloads", async () => {
  const f = fixture()
  expect((await f.handler(request(null))).status).toBe(400)
  const handler = createProvisionHandler({ config, apiFetch: f.apiFetch })
  expect((await handler(request(null))).status).toBe(400)
})

it("validates and forwards promotional license creation", async () => {
  const f = fixture()
  const policyId = "22222222-2222-2222-2222-222222222222"
  const productId = "33333333-3333-3333-3333-333333333333"
  f.records[`/policies/${policyId}`] = {
    relationships: { product: { data: { id: productId } } },
  }
  f.records[`/products/${productId}`] = {
    id: productId,
    attributes: { code: "nimbus" },
  }
  f.records["/licenses"] = { type: "licenses", id }
  const body = {
    data: {
      type: "licenses",
      attributes: {
        name: "Nimbus Promo",
        metadata: {
          app: "nimbus",
          promo: true,
          promoType: "",
          recipientEmail: "ada@example.com",
          recipientFirstName: "Ada",
          recipientLastName: "",
          reason: "Review",
        },
      },
      relationships: { policy: { data: { type: "policies", id: policyId } } },
    },
  }
  const handler = createProvisionHandler({ config, apiFetch: f.apiFetch })
  expect(
    (
      await handler(
        request({
          endpoint: "/accounts/account/licenses",
          method: "POST",
          body,
        }),
      )
    ).status,
  ).toBe(200)
  expect(f.apiFetch.mock.calls.at(-1)[1].method).toBe("POST")
  body.data.attributes.metadata.app = "other"
  expect(
    (
      await handler(
        request({
          endpoint: "/accounts/account/licenses",
          method: "POST",
          body,
        }),
      )
    ).status,
  ).toBe(400)
})
it("allows ownership only for the promotional recipient", async () => {
  const f = fixture()
  const ownerId = "22222222-2222-2222-2222-222222222222"
  f.records[`/users/${ownerId}`] = f.records["/users/user"]
  f.records[`/licenses/${id}/owner`] = { type: "licenses", id }
  const handler = createProvisionHandler({ config, apiFetch: f.apiFetch })
  const body = {
    endpoint: `/accounts/account/licenses/${id}/owner`,
    method: "PUT",
    body: { data: { type: "users", id: ownerId } },
  }
  expect((await handler(request(body))).status).toBe(200)
  f.records[`/users/${ownerId}`].attributes.email = "wrong@example.com"
  expect((await handler(request(body))).status).toBe(400)
})
it("blocks duplicate provisioning submissions while the first write is pending", async () => {
  const f = fixture()
  const original = f.apiFetch.getMockImplementation()
  let finish
  f.apiFetch.mockImplementation(async (url, options) =>
    options.method === "POST"
      ? new Promise((resolve) => {
          finish = () =>
            resolve(new Response(JSON.stringify({ data: { id: "user" } })))
        })
      : original(url, options),
  )
  const handler = createProvisionHandler({ config, apiFetch: f.apiFetch })
  const body = {
    endpoint: "/accounts/account/users",
    method: "POST",
    body: {
      data: {
        type: "users",
        attributes: { email: "ada@example.com", firstName: "Ada" },
      },
    },
  }
  const first = handler(request(body))
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
  expect((await handler(request(body))).status).toBe(409)
  expect((await handler(request(body))).status).toBe(409)
  finish()
  expect((await first).status).toBe(200)
})

it("uses the stored marketing name throughout email and omits pricing", () => {
  const f = fixture()
  const license = f.records[`/licenses/${id}`]
  license.attributes.metadata.marketingProductName = "Forge Studio <Pro>"
  const mail = renderMail(
    license,
    f.records["/users/user"],
    f.records["/products/product"],
    config.support,
  )
  expect(mail.subject).toBe("Your Forge Studio <Pro> promotional license")
  expect(mail.html).toContain("Forge Studio &lt;Pro&gt;")
  expect(mail.text).toContain("Forge Studio <Pro>")
  expect(mail.html).not.toContain("Amount")
  expect(mail.text).not.toContain("Amount:")
  expect(mail.html).not.toContain("$0.00")
  license.attributes.metadata.marketingProductName = ""
  expect(
    renderMail(
      license,
      f.records["/users/user"],
      f.records["/products/product"],
      config.support,
    ).subject,
  ).toContain("Nimbus")
})
