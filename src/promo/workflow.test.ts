import { beforeEach, describe, expect, it, vi } from "vitest"
import { UserRole } from "@/types/users"
import type { Product } from "@/types/products"
import {
  initialProgress,
  licenseName,
  metadata,
  PromoSchema,
  provision,
  type Progress,
} from "./workflow"
import { renderEmail } from "./email"
const api = vi.hoisted(() => ({
  profiles: { me: vi.fn() },
  policies: { get: vi.fn() },
  users: { get: vi.fn(), create: vi.fn() },
  licenses: { create: vi.fn(), changeOwner: vi.fn() },
}))
vi.mock("@/keygen", () => api)
const product = {
  id: "product",
  attributes: { name: "Nimbus", code: "nimbus" },
} as Product
const values = PromoSchema.parse({
  firstName: "Ada",
  email: "ada@example.com",
  productId: "product",
  policyId: "policy",
  reason: "Review",
  sendEmail: false,
})
const user = { id: "user", attributes: { email: values.email } }
const license = {
  id: "license",
  attributes: { name: "Promo", key: "test-key" },
}
beforeEach(() => {
  vi.resetAllMocks()
  api.profiles.me.mockResolvedValue({
    data: { attributes: { role: UserRole.Admin } },
  })
  api.policies.get.mockResolvedValue({
    data: { relationships: { product: { data: { id: product.id } } } },
  })
  api.users.get.mockResolvedValue({ data: user })
  api.users.create.mockResolvedValue({ data: user })
  api.licenses.create.mockResolvedValue({ data: license })
  api.licenses.changeOwner.mockResolvedValue({ data: license })
})
describe("promotional provisioning", () => {
  it("validates required fields and names products dynamically", () => {
    for (const key of ["firstName", "email", "productId", "policyId", "reason"])
      expect(PromoSchema.safeParse({ ...values, [key]: "" }).success).toBe(
        false,
      )
    expect(licenseName(values, product)).toBe("Nimbus Promo (ada@example.com)")
    expect(licenseName({ ...values, name: "Custom" }, product)).toBe("Custom")
    expect(metadata(values, product)).toMatchObject({
      app: "nimbus",
      promo: true,
      reason: "Review",
    })
  })
  it("reuses existing customers and skips email", async () => {
    const result = await provision(values, product, initialProgress(), () => {})
    expect(result).toMatchObject({ owner: true, email: "skipped" })
    expect(api.users.create).not.toHaveBeenCalled()
    expect(api.licenses.changeOwner).toHaveBeenCalledWith({
      id: "license",
      ownerId: "user",
      promo: true,
    })
  })
  it("creates missing customers without password provisioning", async () => {
    api.users.get.mockResolvedValue({ errors: [{ code: "NOT_FOUND" }] })
    await provision(values, product, initialProgress(), () => {})
    expect(api.users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: values.email, firstName: "Ada" }),
      { promo: true },
    )
  })
  it("does not create users on authorization or lookup failures", async () => {
    api.users.get.mockResolvedValue({ errors: [{ code: "FORBIDDEN" }] })
    await expect(
      provision(values, product, initialProgress(), () => {}),
    ).rejects.toThrow()
    expect(api.users.create).not.toHaveBeenCalled()
  })
  it("rejects non administrators and mismatched product policies", async () => {
    api.profiles.me.mockResolvedValue({
      data: { attributes: { role: UserRole.User } },
    })
    await expect(
      provision(values, product, initialProgress(), () => {}),
    ).rejects.toThrow("Administrator")
    expect(api.licenses.create).not.toHaveBeenCalled()
    api.profiles.me.mockResolvedValue({
      data: { attributes: { role: UserRole.Admin } },
    })
    api.policies.get.mockResolvedValue({
      data: { relationships: { product: { data: { id: "other" } } } },
    })
    await expect(
      provision(values, product, initialProgress(), () => {}),
    ).rejects.toThrow("Policy")
  })
  it("preserves customer when license fails", async () => {
    api.licenses.create.mockResolvedValue({
      errors: [{ detail: "Policy denied" }],
    })
    let state = initialProgress()
    await expect(
      provision(values, product, state, (p) => {
        state = { ...p }
      }),
    ).rejects.toThrow("Policy denied")
    expect(state.user?.id).toBe("user")
    expect(state.license).toBeUndefined()
  })
  it("recovers ownership without duplicate creation", async () => {
    api.licenses.changeOwner.mockResolvedValueOnce({
      errors: [{ detail: "Owner failed" }],
    })
    let state = initialProgress()
    await expect(
      provision(values, product, state, (p) => {
        state = { ...p }
      }),
    ).rejects.toThrow("Owner failed")
    await provision(values, product, state, (p) => {
      state = { ...p }
    })
    expect(state.owner).toBe(true)
    expect(api.licenses.create).toHaveBeenCalledTimes(1)
  })
  it("does not recreate licenses after email failure", async () => {
    const state = await provision(
      { ...values, sendEmail: true },
      product,
      initialProgress(),
      () => {},
    )
    await provision(
      { ...values, sendEmail: true },
      product,
      { ...state, email: "failed" },
      () => {},
    )
    expect(api.licenses.create).toHaveBeenCalledTimes(1)
  })
  it("blocks creation retries after ambiguous transport failures", async () => {
    api.licenses.create.mockRejectedValue(new Error("Disconnected"))
    let state: Progress = initialProgress()
    await expect(
      provision(values, product, state, (p) => {
        state = { ...p }
      }),
    ).rejects.toThrow("interrupted")
    await expect(provision(values, product, state, () => {})).rejects.toThrow(
      "Check existing",
    )
    expect(api.licenses.create).toHaveBeenCalledTimes(1)
  })
  it.each(["Nimbus", "Forge"])(
    "renders %s with safe HTML and a placeholder key",
    (name) => {
      const html = renderEmail({
        PRODUCT_NAME: name,
        LICENSE_KEY: "[PREVIEW]",
        CUSTOMER_EMAIL: "<script>alert(1)</script>",
      })
      expect(html).toContain(name)
      expect(html).toContain("[PREVIEW]")
      expect(html).not.toContain("<script>")
      expect(html).toContain("&lt;script&gt;")
      expect(html).not.toContain("request this purchase")
    },
  )
})
