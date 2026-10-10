import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { PromoAction } from "./promo-dialog"
import { UserRole } from "@/types/users"
const state = vi.hoisted(() => ({
  role: "admin",
  allowed: true,
  isDemo: false,
  isTokenAuthenticated: true,
}))
vi.mock("@/keygen", () => ({ config: state }))
vi.mock("@/queries/users", () => ({
  useGetCurrentUser: () => ({ data: { attributes: { role: state.role } } }),
}))
vi.mock("@/queries/products", () => ({ useListProducts: () => ({ data: [] }) }))
vi.mock("@/queries/policies", () => ({ useListPolicies: () => ({ data: [] }) }))
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ canAll: () => state.allowed }),
}))
vi.mock("@/hooks/use-environment", () => ({
  useEnvironment: () => ({ code: null }),
}))
vi.mock("@/hooks/use-resource-navigate", () => ({
  useResourceNavigate: () => vi.fn(),
}))
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
describe("promotional action access", () => {
  it("shows the action only for admins with all required permissions", () => {
    state.role = UserRole.Admin
    state.allowed = true
    expect(renderToStaticMarkup(<PromoAction />)).toContain(
      "Create Promo License",
    )
    state.role = UserRole.User
    expect(renderToStaticMarkup(<PromoAction />)).toBe("")
    state.role = UserRole.Admin
    state.allowed = false
    expect(renderToStaticMarkup(<PromoAction />)).toBe("")
    state.allowed = true
  })
  it("excludes demo and session authentication modes", () => {
    state.isDemo = true
    expect(renderToStaticMarkup(<PromoAction />)).toBe("")
    state.isDemo = false
    state.isTokenAuthenticated = false
    expect(renderToStaticMarkup(<PromoAction />)).toBe("")
    state.isTokenAuthenticated = true
  })
})
