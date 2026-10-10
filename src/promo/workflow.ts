import { z } from "zod"
import { UserRole } from "@/types/users"
import * as keygen from "@/keygen"
import { CreateSchema as LicenseSchema } from "@/schemas/licenses"
import { CreateSchema as UserSchema } from "@/schemas/users"
import { recordToMetadataPairs } from "@/schemas/metadata"
import type { License } from "@/types/licenses"
import type { User } from "@/types/users"
import type { Product } from "@/types/products"

export const PromoSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).default(""),
  email: z.string().trim().email().max(254),
  productId: z.string().min(1),
  policyId: z.string().min(1),
  marketingName: z.string().trim().max(255).default(""),
  name: z.string().trim().max(255).default(""),
  reason: z.string().trim().min(1).max(255),
  tag: z.string().trim().max(255).default(""),
  sendEmail: z.boolean().default(true),
})
export type PromoValues = z.infer<typeof PromoSchema>
export type Progress = {
  user?: User
  license?: License
  owner: boolean
  email: "pending" | "sent" | "skipped" | "failed"
  uncertain?: boolean
}
export const initialProgress = (): Progress => ({
  owner: false,
  email: "pending",
})
export function licenseName(v: PromoValues, product: Product) {
  return v.name || `${product.attributes.name} Promo (${v.email})`
}
export function metadata(v: PromoValues, product: Product) {
  return {
    app: product.attributes.code || product.id,
    promo: true,
    ...(v.marketingName ? { marketingProductName: v.marketingName } : {}),
    promoType: v.tag,
    recipientEmail: v.email,
    recipientFirstName: v.firstName,
    recipientLastName: v.lastName,
    reason: v.reason,
  }
}
function unwrap<T>(response: {
  data?: T
  errors?: { code?: string; detail?: string }[]
}): T {
  if (!response.data)
    throw new Error(response.errors?.[0]?.detail || "Keygen operation failed")
  return response.data
}
export async function provision(
  v: PromoValues,
  product: Product,
  progress: Progress,
  update: (p: Progress) => void,
) {
  v = PromoSchema.parse(v)
  const me = unwrap(await keygen.profiles.me())
  if (me.attributes.role !== UserRole.Admin)
    throw new Error("Administrator access required")
  if (product.id !== v.productId) throw new Error("Product selection changed")
  const policy = unwrap(
    await keygen.policies.get({ id: v.policyId, promo: true }),
  )
  if (policy.relationships.product?.data?.id !== product.id)
    throw new Error("Policy does not belong to selected product")
  const p = { ...progress }
  if (p.uncertain)
    throw new Error(
      "Check existing licenses before starting another creation: the previous response was interrupted.",
    )
  if (!p.user) {
    const lookup = await keygen.users.get({
      id: encodeURIComponent(v.email),
      promo: true,
    })
    if (lookup.data) p.user = lookup.data
    else if (lookup.errors?.[0]?.code === "NOT_FOUND") {
      const created = await keygen.users.create(
        UserSchema.parse({
          email: v.email,
          firstName: v.firstName,
          lastName: v.lastName,
        }),
        { promo: true },
      )
      // A concurrent administrator may have created this email.
      p.user =
        created.data ??
        (created.errors?.[0]?.code === "EMAIL_TAKEN"
          ? unwrap(
              await keygen.users.get({
                id: encodeURIComponent(v.email),
                promo: true,
              }),
            )
          : unwrap(created))
    } else unwrap(lookup)
    update(p)
  }
  if (!p.license) {
    let response
    try {
      response = await keygen.licenses.create(
        LicenseSchema.parse({
          name: licenseName(v, product),
          policyId: v.policyId,
          metadata: recordToMetadataPairs(metadata(v, product)),
        }),
        { promo: true },
      )
    } catch {
      p.uncertain = true
      update(p)
      throw new Error(
        "License creation response interrupted. Check Licenses before creating again; it may have succeeded.",
      )
    }
    p.license = unwrap(response)
    update(p)
  }
  if (!p.owner) {
    unwrap(
      await keygen.licenses.changeOwner({
        id: p.license.id,
        ownerId: p.user!.id,
        promo: true,
      }),
    )
    p.owner = true
    update(p)
  }
  if (!v.sendEmail) {
    p.email = "skipped"
    update(p)
  }
  return p
}
