import config from "@/keygen/config"
import client from "@/keygen/client"

import { UserResponse } from "@/types/users"
import { compact } from "@/lib/compact"

import * as Schemas from "@/schemas"

config.validate()

export default async function create(
  values: Schemas.Users.CreateValues,
  options?: { promo?: boolean },
): Promise<UserResponse> {
  const { groupId, permissions, ...attributes } = values
  void groupId

  const body = {
    data: {
      type: "users",
      attributes: compact({
        ...attributes,
        permissions: !config.isCE ? permissions : undefined,
      }),
    },
  }

  const result = (await client.request(`/accounts/${config.id}/users`, {
    method: "POST",
    promo: options?.promo,
    body: JSON.stringify(body),
  })) as UserResponse

  return result
}
