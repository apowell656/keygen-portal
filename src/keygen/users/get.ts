import config from "@/keygen/config"
import client from "@/keygen/client"
import { UserResponse } from "@/types/users"

config.validate()

interface GetProps {
  id: string
  promo?: boolean
}

export default async function get({
  id,
  promo,
}: GetProps): Promise<UserResponse> {
  const result = (await client.request(`/accounts/${config.id}/users/${id}`, {
    method: "GET",
    promo,
    root: client.currentUser === id,
  })) as UserResponse

  return result
}
