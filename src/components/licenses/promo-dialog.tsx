import { PromoEmailRecovery } from "./promo-email-recovery"
import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useListProducts } from "@/queries/products"
import { useListPolicies } from "@/queries/policies"
import { useGetCurrentUser } from "@/queries/users"
import { usePermissions } from "@/hooks/use-permissions"
import { cursorFromLink } from "@/hooks/use-cursors"
import { useEnvironment } from "@/hooks/use-environment"
import { useResourceNavigate } from "@/hooks/use-resource-navigate"
import {
  initialProgress,
  licenseName,
  PromoSchema,
  provision,
  type PromoValues,
} from "@/promo/workflow"
import { renderEmail } from "@/promo/email"
import { UserRole } from "@/types/users"
import * as keygen from "@/keygen"

export function PromoAction() {
  const [open, setOpen] = useState(false)
  const { data: me } = useGetCurrentUser()
  const { canAll } = usePermissions()
  if (
    keygen.config.isDemo ||
    !keygen.config.isTokenAuthenticated ||
    me?.attributes.role !== UserRole.Admin ||
    !canAll([
      "license.create",
      "license.owner.update",
      "user.read",
      "user.create",
      "policy.read",
      "product.read",
    ])
  )
    return null
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Create Promo License
      </Button>
      <PromoEmailRecovery />
      <PromoDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
function PromoDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [values, setValues] = useState<PromoValues>({
    marketingName: "",
    firstName: "",
    lastName: "",
    email: "",
    productId: "",
    policyId: "",
    name: "",
    reason: "Giveaway",
    tag: "",
    sendEmail: true,
  })
  const [progress, setProgress] = useState(initialProgress)
  const [review, setReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const lock = useRef(false)
  const { code } = useEnvironment()
  const startedEnvironment = useRef<string | null | undefined>(undefined)
  const [productPages, setProductPages] = useState<(string | null)[]>([null])
  const [policyPages, setPolicyPages] = useState<(string | null)[]>([null])
  const products = useListProducts(
    { pageSize: 100, cursor: productPages.at(-1) },
    { enabled: open },
  )
  const policies = useListPolicies(
    {
      pageSize: 100,
      cursor: policyPages.at(-1),
      filters: { product: values.productId },
    },
    { enabled: open && !!values.productId },
  )
  const product = products.data.find((p) => p.id === values.productId)
  const policy = policies.data.find(
    (p) =>
      p.id === values.policyId &&
      p.relationships.product?.data?.id === values.productId,
  )
  const queryClient = useQueryClient()
  const navigate = useResourceNavigate()
  const field = (key: keyof PromoValues, value: string | boolean) => {
    if (key === "productId") setPolicyPages([null])
    setReview(false)
    setValues((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "productId" ? { policyId: "" } : {}),
    }))
  }
  const frozen =
    busy || !!progress.user || !!progress.license || !!progress.uncertain
  const complete =
    progress.owner && ["sent", "skipped"].includes(progress.email)
  async function submit() {
    if (lock.current || complete || !product || !policy) return
    if (
      startedEnvironment.current !== undefined &&
      startedEnvironment.current !== code
    ) {
      setError(
        "Return to the environment where this workflow started before retrying.",
      )
      return
    }
    lock.current = true
    setBusy(true)
    setError("")
    startedEnvironment.current = code
    let current = progress
    const update = (p: typeof progress) => {
      current = p
      setProgress({ ...p })
    }
    try {
      current = await provision(values, product, current, update)
      if (values.sendEmail && current.email !== "sent") {
        try {
          await keygen.client.sendPromoEmail(
            current.license!.id,
            current.license!.attributes.key?.length <= 4096
              ? current.license!.attributes.key
              : undefined,
          )
          update({ ...current, email: "sent" })
        } catch (e) {
          update({ ...current, email: "failed" })
          throw e
        }
      }
      toast.success("Promotional license created")
    } catch (e) {
      const message = e instanceof Error ? e.message : "Workflow failed"
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
      lock.current = false
      await queryClient.invalidateQueries({ queryKey: ["licenses"] })
      await queryClient.invalidateQueries({ queryKey: ["users"] })
    }
  }
  const preview = product
    ? renderEmail({
        PRODUCT_NAME: values.marketingName.trim() || product.attributes.name,
        LICENSE_KEY:
          progress.license?.attributes.key ||
          "[PREVIEW — license key not yet generated]",
        ORDER_DATE:
          progress.license?.attributes.created || new Date().toISOString(),
        CUSTOMER_EMAIL: values.email,
        SUPPORT_EMAIL: keygen.config.supportEmail || "support@aeriform.app",
      })
    : ""
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90vh] gap-6 overflow-y-auto p-6 sm:max-w-2xl sm:p-8">
        <DialogHeader>
          <DialogTitle>Create Promo License</DialogTitle>
          <DialogDescription>
            Create a promotional license using an existing product and policy.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (review) void submit()
            else {
              const result = PromoSchema.safeParse(values)
              if (!result.success || !product || !policy)
                setError(
                  "Enter a first name, valid email, reason, product, and associated policy.",
                )
              else {
                setError("")
                setReview(true)
              }
            }
          }}
          className="space-y-4"
        >
          <fieldset disabled={frozen} className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["firstName", "First name (required)"],
                ["lastName", "Last name"],
                ["email", "Email (required)"],
                ["name", "License name (optional)"],
                ["marketingName", "Product name for email (optional)"],
                ["reason", "Reason (required)"],
                ["tag", "Promo tag"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <Label htmlFor={`promo-${key}`}>{label}</Label>
                <Input
                  id={`promo-${key}`}
                  type={key === "email" ? "email" : "text"}
                  required={["firstName", "email", "reason"].includes(key)}
                  maxLength={key === "email" ? 254 : 255}
                  placeholder={
                    key === "marketingName"
                      ? product?.attributes.name
                      : undefined
                  }
                  list={key === "reason" ? "promo-reasons" : undefined}
                  value={values[key]}
                  onChange={(e) => field(key, e.target.value)}
                />
              </div>
            ))}
            <datalist id="promo-reasons">
              {["Giveaway", "Review", "Partner", "Promotional", "Other"].map(
                (v) => (
                  <option key={v} value={v} />
                ),
              )}
            </datalist>
            <div>
              <Label>Product</Label>
              <Select
                disabled={frozen || products.isLoading}
                value={values.productId}
                onValueChange={(v) => field("productId", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a product" />
                </SelectTrigger>
                <SelectContent>
                  {products.data.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.attributes.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>License policy</Label>
              <Select
                disabled={frozen || policies.isLoading || !product}
                value={values.policyId}
                onValueChange={(v) => field("policyId", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an associated policy" />
                </SelectTrigger>
                <SelectContent>
                  {policies.data
                    .filter(
                      (p) =>
                        p.relationships.product?.data?.id === values.productId,
                    )
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.attributes.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={values.sendEmail}
                onChange={(e) => field("sendEmail", e.target.checked)}
              />
              Send email
            </label>
          </fieldset>
          {(products.error || policies.error) && (
            <p role="alert">Unable to load products or policies. Try again.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {productPages.length > 1 && (
              <Button
                type="button"
                disabled={frozen}
                variant="outline"
                onClick={() => {
                  field("productId", "")
                  setProductPages(productPages.slice(0, -1))
                }}
              >
                Previous products
              </Button>
            )}
            {products.links?.next && (
              <Button
                type="button"
                disabled={frozen}
                variant="outline"
                onClick={() => {
                  field("productId", "")
                  setProductPages([
                    ...productPages,
                    cursorFromLink(products.links?.next),
                  ])
                }}
              >
                More products
              </Button>
            )}
            {policyPages.length > 1 && (
              <Button
                type="button"
                disabled={frozen}
                variant="outline"
                onClick={() => {
                  field("policyId", "")
                  setPolicyPages(policyPages.slice(0, -1))
                }}
              >
                Previous policies
              </Button>
            )}
            {policies.links?.next && (
              <Button
                type="button"
                disabled={frozen}
                variant="outline"
                onClick={() => {
                  field("policyId", "")
                  setPolicyPages([
                    ...policyPages,
                    cursorFromLink(policies.links?.next),
                  ])
                }}
              >
                More policies
              </Button>
            )}
          </div>
          {review && product && (
            <p>
              Confirm: create {licenseName(values, product)} for{" "}
              {values.firstName} {values.lastName} ({values.email}), using{" "}
              {product.attributes.name} / {policy?.attributes.name}. Reason:{" "}
              {values.reason}. Email will be{" "}
              {values.sendEmail ? "sent" : "skipped"}. Customer and license
              creation cannot be undone by closing this dialog.
            </p>
          )}
          {product && (
            <details>
              <summary>
                Email preview {progress.license ? "" : "(placeholder key)"}
              </summary>
              <iframe
                title="Promotional email preview"
                sandbox=""
                srcDoc={preview}
                className="h-96 w-full border"
              />
            </details>
          )}
          {progress.user && (
            <p>
              Customer: {progress.user.attributes.email}{" "}
              <Button
                type="button"
                variant="link"
                onClick={() => void navigate(progress.user!)}
              >
                View customer
              </Button>
            </p>
          )}
          {progress.license && (
            <div className="space-y-2">
              <p>
                {product?.attributes.name} / {policy?.attributes.name}
              </p>
              <p>License: {progress.license.attributes.name}</p>
              <p>ID: {progress.license.id}</p>
              <p className="break-all">
                Key: {progress.license.attributes.key}
              </p>
              <p>
                Ownership: {progress.owner ? "assigned" : "pending"} · Email:{" "}
                {progress.email}
              </p>
              <Button
                type="button"
                variant="link"
                onClick={() => void navigate(progress.license!)}
              >
                View license
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {!complete && (
            <Button
              type="submit"
              disabled={
                busy ||
                !!progress.uncertain ||
                products.isLoading ||
                policies.isLoading
              }
            >
              {busy
                ? "Processing…"
                : progress.license
                  ? progress.owner
                    ? "Retry email delivery"
                    : "Retry ownership assignment"
                  : review
                    ? "Confirm and create"
                    : "Review and preview"}
            </Button>
          )}
          {complete && (
            <Button
              type="button"
              onClick={() => {
                setProgress(initialProgress())
                setReview(false)
                startedEnvironment.current = undefined
                setValues({
                  ...values,
                  email: "",
                  firstName: "",
                  lastName: "",
                  name: "",
                })
              }}
            >
              Create another promo license
            </Button>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}
