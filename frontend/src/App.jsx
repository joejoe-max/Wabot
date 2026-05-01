import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";

const Landing   = lazy(() => import("./pages/Landing.jsx"));
const Login     = lazy(() => import("./pages/Login.jsx"));
const Signup    = lazy(() => import("./pages/Signup.jsx"));
const Verify    = lazy(() => import("./pages/Verify.jsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));

function Loader() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <span className="spinner spinner-lg" />
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { token } = useAuth();
  const location  = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

function GuestRoute({ children }) {
  const { token } = useAuth();
  if (token) return <Navigate to="/dashboard" replace />;
  return children;
}

export default function App() {
  return (
    <Suspense fallback={<Loader />}>
      <Routes>
        <Route path="/"          element={<Landing />} />
        <Route path="/verify"    element={<Verify />} />
        <Route path="/login"     element={<GuestRoute><Login /></GuestRoute>} />
        <Route path="/signup"    element={<GuestRoute><Signup /></GuestRoute>} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="*"          element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
