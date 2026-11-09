import { useSession } from '../state'

/** Product mark: the totem head, green on light, ivory on dark. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <>
      <img className="light-only" src="/brand/tete-vert-128.png" width={size} height={size} alt="" />
      <img className="dark-only" src="/brand/tete-ivoire-128.png" width={size} height={size} alt="" />
    </>
  )
}

export function BrandName() {
  const { config, me } = useSession()
  return <>{me?.app.brand ?? config?.brand ?? 'Akili'}</>
}
