import AssetDetail from "@/components/AssetDetail";

export default async function AssetPage({ params }: PageProps<"/asset/[id]">) {
  const { id } = await params;
  return <AssetDetail id={Number(id)} />;
}
