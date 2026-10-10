import { useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useEnvironment } from "@/hooks/use-environment"
import { renderEmail } from "@/promo/email"
import type { License } from "@/types/licenses"
import * as keygen from "@/keygen"

export function PromoEmailRecovery() {
  const [open, setOpen] = useState(false)
  const [id, setId] = useState("")
  const [originalKey, setOriginalKey] = useState("")
  const [review, setReview] = useState<{
    license: License
    html: string
    environment: string | null
    deliveryKey: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sent, setSent] = useState(false)
  const lock = useRef(false)
  const { code } = useEnvironment()
  function resetReview() {
    setReview(null)
    setError("")
    setSent(false)
  }
  async function submit() {
    if (lock.current || sent) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      if (review) {
        if (review.environment !== code)
          throw new Error(
            "Return to the environment where this license was loaded before sending.",
          )
        await keygen.client.sendPromoEmail(
          review.license.id,
          review.license.attributes.key ? undefined : review.deliveryKey,
        )
        setSent(true)
        setOriginalKey("")
        setReview(null)
        toast.success("Promotional email sent using the existing license")
      } else {
        if (!/^[a-f0-9-]{36}$/i.test(id.trim()))
          throw new Error("Enter the existing license ID")
        const result = await keygen.licenses.get({ id: id.trim() })
        if (!result.data) throw new Error("License could not be loaded")
        const license = result.data
        if (
          license.attributes.metadata.promo !== true ||
          !license.relationships.owner?.data?.id
        )
          throw new Error("An assigned promotional license is required")
        if (
          license.attributes.key &&
          originalKey.trim() &&
          originalKey.trim() !== license.attributes.key
        )
          throw new Error("The supplied key does not match this license")
        const deliveryKey = license.attributes.key || originalKey.trim()
        if (!deliveryKey)
          throw new Error(
            "Enter the original key shown when this legacy license was created. Keygen stores only its hash and cannot recover it after a refresh.",
          )
        const productId = license.relationships.product?.data?.id
        if (!productId)
          throw new Error("License product could not be determined")
        const productResult = await keygen.products.get({ id: productId })
        if (!productResult.data) throw new Error("Product could not be loaded")
        const metadata = license.attributes.metadata
        const html = renderEmail({
          PRODUCT_NAME:
            typeof metadata.marketingProductName === "string" &&
            metadata.marketingProductName.trim()
              ? metadata.marketingProductName
              : productResult.data.attributes.name,
          LICENSE_KEY: deliveryKey,
          ORDER_DATE: license.attributes.created,
          CUSTOMER_EMAIL:
            typeof metadata.recipientEmail === "string"
              ? metadata.recipientEmail
              : "",
          SUPPORT_EMAIL: keygen.config.supportEmail || "support@aeriform.app",
        })
        setReview({ license, html, environment: code, deliveryKey })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Email recovery failed"
      setError(message)
      toast.error(message)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Retry Promo Email
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) {
            setOpen(next)
            if (!next) {
              setOriginalKey("")
              setReview(null)
            }
          }
        }}
      >
        <DialogContent className="max-h-[90vh] gap-6 overflow-y-auto p-6 sm:max-w-2xl sm:p-8">
          <DialogHeader>
            <DialogTitle>Retry Promo Email</DialogTitle>
            <DialogDescription>
              Send the approved email to the owner of an existing promotional
              license. This action creates no license or customer.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div>
              <Label htmlFor="promo-recovery-id">Existing license ID</Label>
              <Input
                id="promo-recovery-id"
                required
                disabled={busy || !!review}
                value={id}
                onChange={(e) => {
                  setId(e.target.value)
                  resetReview()
                }}
              />
            </div>
            <div>
              <Label htmlFor="promo-recovery-key">
                Original license key (required for legacy encryption)
              </Label>
              <Input
                id="promo-recovery-key"
                type="password"
                autoComplete="off"
                maxLength={4096}
                disabled={busy || !!review}
                value={originalKey}
                onChange={(e) => {
                  setOriginalKey(e.target.value)
                  resetReview()
                }}
              />
              <p className="text-sm text-content-muted">
                Use the key saved at creation. It is verified server-side and
                kept only in memory.
              </p>
            </div>
            {review && (
              <>
                <p>
                  Confirm delivery for {review.license.attributes.name} to{" "}
                  {typeof review.license.attributes.metadata.recipientEmail ===
                  "string"
                    ? review.license.attributes.metadata.recipientEmail
                    : "the assigned owner"}{" "}
                  using license {review.license.id}.
                </p>
                <details>
                  <summary>Email preview</summary>
                  <iframe
                    title="Existing promotional license email preview"
                    sandbox=""
                    srcDoc={review.html}
                    className="h-96 w-full border"
                  />
                </details>
              </>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            {sent ? (
              <p role="status">Email sent using the existing license.</p>
            ) : (
              <Button type="submit" disabled={busy}>
                {busy
                  ? "Processing…"
                  : review
                    ? "Confirm and send email"
                    : "Load license and preview"}
              </Button>
            )}
            {review && !busy && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setReview(null)}
              >
                Edit recovery details
              </Button>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
