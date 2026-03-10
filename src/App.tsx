import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Outlet } from "react-router";
import { useAppStore } from "./store";
import Home from "./pages/Home";
import RepoDetail from "./pages/RepoDetail";
import History from "./pages/History";
import RunDetail from "./pages/RunDetail";
import OneShotDetail from "./pages/OneShotDetail";
import DesignSystem from "./pages/DesignSystem";
import { Toaster } from "@/components/ui/sonner";

function Layout() {
  const initialize = useAppStore((s) => s.initialize);

  useEffect(() => {
    const cleanup = initialize();
    return cleanup;
  }, [initialize]);

  return <Outlet />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/repo/:repoId" element={<RepoDetail />} />
        <Route path="/oneshot/:oneshotId" element={<OneShotDetail />} />
        <Route path="/history" element={<History />} />
        <Route path="/history/:repoId" element={<History />} />
        <Route path="/run/:repoId/:sessionId" element={<RunDetail />} />
        <Route path="/design-system" element={<DesignSystem />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
      <Toaster />
    </BrowserRouter>
  );
}
