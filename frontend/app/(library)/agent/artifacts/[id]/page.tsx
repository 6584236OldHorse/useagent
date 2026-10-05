import { decodeArtifactResult } from "@useagent/agent-client";
import { notFound } from "next/navigation";
import { backendFetch } from "@/lib/backend-fetch";
import { ArtifactEditor } from "./artifact-editor";

export default async function ArtifactEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const response = await backendFetch(`/api/artifacts/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (!response.ok) notFound();
  const result = decodeArtifactResult(await response.json());
  if (!result?.artifact.workpiece) notFound();

  return (
    <ArtifactEditor artifact={result.artifact} />
  );
}
