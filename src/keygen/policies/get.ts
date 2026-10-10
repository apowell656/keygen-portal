import config from "@/keygen/config"
import client from "@/keygen/client"
import { PolicyResponse } from "@/types/policies"

config.validate()

interface GetProps {
  id: string
  promo?: boolean
}

export default async function get({
  id,
  promo,
}: GetProps): Promise<PolicyResponse> {
  const result = (await client.request(
    `/accounts/${config.id}/policies/${id}`,
    {
      method: "GET",
      promo,
    },
  )) as PolicyResponse

  return result
}
