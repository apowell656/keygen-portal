import config from "@/keygen/config"

import { APIResponse, APIError } from "@/types/api"

async function resolveFetch(): Promise<typeof fetch> {
  if (!config.isDemo) return fetch

  const demo = await import("@/demo")
  return demo.fetchMock
}

export class Client {
  private host = `https://${config.host}`

  private rootToken?: string | null
  private environmentToken?: string | null
  private environment?: string | null
  private user?: string | null
  private account?: string | null
  private tokenId?: string | null

  constructor(token?: string | null, environment?: string | null) {
    this.rootToken = token ?? null
    this.environment = environment ?? null
  }

  public setRootToken(token: string | null) {
    this.rootToken = token
  }

  public setEnvironmentToken(token: string | null) {
    this.environmentToken = token
  }

  public setEnvironment(code: string | null) {
    this.environment = code
  }

  public setUser(id: string | null) {
    this.user = id
  }

  public setAccount(id: string | null) {
    this.account = id
  }

  public setTokenId(id: string | null) {
    this.tokenId = id
  }

  public get currentUser(): string | null | undefined {
    return this.user
  }

  public get currentAccount(): string | null | undefined {
    return this.account
  }

  public get currentTokenId(): string | null | undefined {
    return this.tokenId
  }

  private get activeToken(): string | null | undefined {
    return this.environmentToken ?? this.rootToken
  }

  async sendPromoEmail(licenseId: string, licenseKey?: string): Promise<void> {
    if (!config.isTokenAuthenticated || !this.activeToken)
      throw new Error("Promo email requires token authentication")
    const response = await fetch("/api/promo/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.activeToken}`,
        ...(this.environment ? { "Keygen-Environment": this.environment } : {}),
      },
      body: JSON.stringify({
        licenseId,
        ...(licenseKey ? { licenseKey } : {}),
      }),
    })
    const result = (await response.json().catch(() => ({}))) as {
      error?: string
    }
    if (!response.ok)
      throw new Error(result.error || "Email delivery endpoint unavailable")
  }

  async request<T = unknown>(
    endpoint: string,
    options: RequestInit & {
      root?: boolean
      promo?: boolean
      signal?: AbortSignal
      prefix?: string
      environment?: string | null
      environmentToken?: string | null
    } = {},
  ): Promise<APIResponse<T>> {
    // override to target an environment other than the active one
    // e.g. creating an environment token from the global context
    const envHeader =
      options.environment !== undefined ? options.environment : this.environment

    const authToken = options.root
      ? this.rootToken
      : options.environmentToken !== undefined
        ? options.environmentToken
        : this.activeToken

    const defaultHeaders = {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      "Keygen-Version": config.version,
      ...(config.isTokenAuthenticated && authToken
        ? { Authorization: `Bearer ${authToken}` }
        : {}),
      ...(options.root || !envHeader
        ? {}
        : { "Keygen-Environment": envHeader }),
    }

    const headers = {
      ...defaultHeaders,
      ...options.headers,
    }

    const {
      root,
      prefix,
      environment,
      environmentToken,
      promo,
      ...fetchOptions
    } = options
    void root
    void environment
    void environmentToken

    if (promo) {
      if (!config.isTokenAuthenticated || !authToken)
        return {
          errors: [
            new APIError({
              title: "Authentication required",
              detail: "Promotional provisioning requires token authentication",
              code: "PROMO_AUTH",
            }),
          ],
        }
      let promoBody: unknown
      if (options.body != null) {
        if (typeof options.body !== "string")
          throw new Error("Promotional requests require a JSON body")
        promoBody = JSON.parse(options.body) as unknown
      }
      const response = await fetch("/api/promo/keygen", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          ...(envHeader ? { "Keygen-Environment": envHeader } : {}),
        },
        body: JSON.stringify({
          endpoint,
          method: options.method ?? "GET",
          body: promoBody,
        }),
      })
      if (!response.ok)
        throw new Error(
          "Promotional provisioning endpoint rejected or could not confirm the request; check existing records before retrying",
        )
      return (await response.json()) as APIResponse<T>
    }
    const request = await resolveFetch()
    const response = await request(
      `${this.host}/${prefix ?? "v1"}${endpoint}`,
      {
        ...fetchOptions,
        headers,
        ...(config.isSessionAuthenticated ? { credentials: "include" } : {}),
      },
    )

    const data = (await response.json().catch(() => ({}))) as APIResponse<T>

    if (response.status === 401 && "errors" in data) {
      const code = data.errors?.[0]?.code
      if (
        code === "SESSION_INVALID" ||
        code === "SESSION_EXPIRED" ||
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED"
      ) {
        window.dispatchEvent(new CustomEvent("keygen:session-expired"))
      }
    }

    // Server error, i.e. "PASSWORD_REQUIRED"
    if ("errors" in data) {
      return data
    }

    // Fallback for unexpected errors
    if (!response.ok) {
      return {
        errors: [
          new APIError({
            title: "Request Error",
            detail: `Request failed: ${response.status}`,
            code: "CLIENT_ERROR",
          }),
        ],
      }
    }

    // Success
    return data
  }
}

const client = new Client()

export default client
