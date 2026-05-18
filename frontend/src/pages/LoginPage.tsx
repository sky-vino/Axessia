import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../store/auth";
import { motion } from "framer-motion";
import { Eye, EyeOff, Loader2 } from "lucide-react";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@axessia.local");
  const [password, setPassword] = useState("Admin@123");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: any) {
      setError(err.response?.data?.error || "Login failed. Check credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* Background grid — uses Sky brand tint */}
      <div className="absolute inset-0 opacity-20"
        style={{ backgroundImage: "linear-gradient(rgba(176, 24, 216, 0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(22, 119, 255, 0.10) 1px, transparent 1px)", backgroundSize: "60px 60px" }} />

      {/* Sky-tinted glow orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-20" style={{ background: "radial-gradient(circle, #e00062, transparent)" }} />
      <div className="absolute bottom-1/4 right-1/4 w-72 h-72 rounded-full opacity-15" style={{ background: "radial-gradient(circle, #1677ff, transparent)" }} />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="relative z-10 w-full max-w-md px-6"
      >
        {/* Axessia + Sky wordmark */}
        <div className="flex items-end gap-3 mb-10 justify-center">
          <span className="sky-wordmark" style={{ fontSize: "2.6rem" }}>sky</span>
          <div className="pb-1">
            <span className="text-2xl font-semibold tracking-tight" style={{ fontFamily: "'DM Sans', sans-serif", color: "var(--text-strong)" }}>
              Axessia
            </span>
            <div className="text-xs leading-none" style={{ color: "var(--muted)" }}>Accessibility Platform</div>
          </div>
        </div>

        <div className="card p-8">
          <h1 className="text-2xl font-semibold mb-1" style={{ color: "var(--text-strong)" }}>Welcome back</h1>
          <p className="text-sm mb-8" style={{ color: "var(--muted)" }}>Sign in to your workspace</p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--muted-strong)" }} htmlFor="email">Username or email</label>
              <input
                id="email"
                type="text"
                autoComplete="username"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full px-4 py-3 rounded-lg text-sm outline-none transition-all"
                style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                placeholder="user1 or you@company.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--muted-strong)" }} htmlFor="password">Password</label>
              <div className="relative">
                <input
                  id="password"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full px-4 py-3 pr-12 rounded-lg text-sm outline-none transition-all"
                  style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
                />
                <button type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors">
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                className="text-sm text-red-400 px-4 py-3 rounded-lg"
                style={{ background: "rgba(255,77,109,0.1)", border: "1px solid rgba(255,77,109,0.2)" }}>
                {error}
              </motion.div>
            )}

            <button
              type="submit"
              disabled={loading}
              className={`w-full py-3 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all ${loading ? "opacity-70" : ""}`}
              style={{ background: "var(--sky-gradient)" }}
            >
              {loading ? <><Loader2 size={16} className="animate-spin" />Signing in…</> : "Sign in"}
            </button>
          </form>

          <p className="text-center text-xs mt-6" style={{ color: "var(--muted)" }}>
            Default: <span className="font-mono">admin@axessia.local / Admin@123</span><br />
            Test users: <span className="font-mono">user1–user5 / Accessibility</span>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
