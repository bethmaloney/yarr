import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import HistoryTable from "@/components/HistoryTable";
import type { SessionTrace } from "../types";

export default function History() {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate = useNavigate();
  const repos = useAppStore((s) => s.repos);

  const [traces, setTraces] = useState<SessionTrace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<SessionTrace[]>("list_traces", { repoId: repoId ?? null })
      .then((result) => {
        if (!cancelled) {
          setTraces(result);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  const repoName = repoId
    ? (repos.find((r) => r.id === repoId)?.name ?? repoId)
    : undefined;

  const breadcrumbs = repoId
    ? [
        { label: "Home", onClick: () => navigate("/") },
        { label: repoName!, onClick: () => navigate("/repo/" + repoId) },
        { label: "History" },
      ]
    : [{ label: "Home", onClick: () => navigate("/") }, { label: "History" }];

  return (
    <main className="p-8">
      <Breadcrumbs crumbs={breadcrumbs} />
      <h1 className="text-3xl font-bold text-primary mb-6">History</h1>
      <HistoryTable
        traces={traces}
        loading={loading}
        error={error}
        showRepo={!repoId}
        repos={repos}
        repoId={repoId}
      />
    </main>
  );
}
