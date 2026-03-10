import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Outlet } from "react-router";
import { useAppStore } from "./store";
import Home from "./pages/Home";
import RepoDetail from "./pages/RepoDetail";
import History from "./pages/History";
import RunDetail from "./pages/RunDetail";

function Layout() {
  const initialize = useAppStore((s) => s.initialize);

  useEffect(() => {
    const cleanup = initialize();
    return cleanup;
  }, [initialize]);

  return <Outlet />;
}

function OneShot() {
  return <div>OneShot</div>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/repo/:repoId" element={<RepoDetail />} />
        <Route path="/repo/:repoId/oneshot" element={<OneShot />} />
        <Route path="/history" element={<History />} />
        <Route path="/history/:repoId" element={<History />} />
        <Route path="/run/:repoId/:sessionId" element={<RunDetail />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
