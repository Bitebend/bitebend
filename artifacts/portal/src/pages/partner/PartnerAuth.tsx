import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Users, Lock, ChevronRight, AlertTriangle, ArrowLeft } from "lucide-react";
import logo from "@/assets/logo.png";

export default function PartnerAuth() {
  const { login, logout } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // Clear any prior active session before attempting partner login
      await logout().catch(() => {});
      const user = await login(email, password);
      if (user.role !== "partner") {
        await logout().catch(() => {});
        setError("Access denied. This portal is for channel partners only.");
        return;
      }
      navigate("/partner/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed. Check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Left branding panel */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-amber-600 via-orange-600 to-amber-700 flex-col items-center justify-center p-12 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute top-0 right-0 w-80 h-80 bg-white/10 rounded-full -translate-y-1/3 translate-x-1/3" />
        <div className="absolute bottom-0 left-0 w-60 h-60 bg-black/15 rounded-full translate-y-1/3 -translate-x-1/3" />
        <div className="absolute top-1/2 left-1/2 w-[600px] h-[600px] bg-white/5 rounded-full -translate-x-1/2 -translate-y-1/2" />

        <div className="relative z-10 text-center text-white space-y-6 max-w-md">
          <img
            src={logo}
            alt="Bitebend"
            className="w-52 h-auto object-contain mx-auto"
            style={{ filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.45))" }}
          />
          <div>
            <h1 className="text-4xl font-black tracking-tight drop-shadow">Bitebend</h1>
            <div className="inline-flex items-center gap-2 mt-2 bg-black/25 backdrop-blur-sm px-4 py-1.5 rounded-full border border-white/20">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />
              <span className="text-sm font-semibold tracking-widest uppercase text-amber-200">
                Channel Partner Portal
              </span>
            </div>
          </div>
          <p className="text-amber-100/90 text-base leading-relaxed">
            Track attributed restaurants, monitor real-time subscription recurring commissions, and manage your payouts.
          </p>

          <div className="grid grid-cols-3 gap-4 mt-8 text-left">
            {[
              { label: "Commission", val: "Recurring" },
              { label: "Tracking", val: "Real-Time" },
              { label: "Payouts", val: "Bank Transfer" },
            ].map((s) => (
              <div
                key={s.label}
                className="bg-white/15 backdrop-blur-sm rounded-xl p-3.5 border border-white/20"
              >
                <p className="text-sm font-bold text-white leading-snug">{s.val}</p>
                <p className="text-[11px] text-amber-200/80 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex flex-col items-center justify-center bg-amber-50/50 p-6">
        {/* Mobile header */}
        <div className="lg:hidden text-center mb-8">
          <img src={logo} alt="Bitebend" className="w-44 h-auto object-contain mx-auto mb-1" />
          <h1 className="text-2xl font-black text-slate-900">Bitebend</h1>
          <p className="text-xs font-semibold text-amber-600 uppercase tracking-widest mt-0.5">
            Channel Partner Portal
          </p>
        </div>

        <div className="w-full max-w-md">
          <div className="bg-white rounded-3xl shadow-xl border border-amber-100/80 overflow-hidden">
            {/* Top accent bar */}
            <div className="h-2 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600" />

            <div className="p-8">
              <div className="flex items-center gap-3 mb-7">
                <div className="w-10 h-10 rounded-xl bg-amber-100/80 text-amber-700 flex items-center justify-center shrink-0">
                  <Users className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-900">Partner Sign In</h2>
                  <p className="text-xs text-slate-500">Access your referral dashboard & commissions</p>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-1.5">
                  <Label htmlFor="partner-email" className="text-sm font-semibold text-slate-700">
                    Partner Email
                  </Label>
                  <Input
                    id="partner-email"
                    type="email"
                    placeholder="partner@bitebend.in"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    className="h-11 border-slate-200 focus-visible:ring-amber-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="partner-password" className="text-sm font-semibold text-slate-700">
                      Password
                    </Label>
                  </div>
                  <Input
                    id="partner-password"
                    type="password"
                    placeholder="••••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="h-11 border-slate-200 focus-visible:ring-amber-500"
                  />
                </div>

                {error && (
                  <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 text-white font-bold text-sm shadow-md shadow-amber-600/20 transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer"
                >
                  {loading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      Sign In to Partner Portal
                      <ChevronRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <div className="text-center pt-2">
                  <p className="text-xs text-slate-500">
                    Don&apos;t have a partner account yet?{" "}
                    <button
                      type="button"
                      onClick={() => navigate("/partner/register")}
                      className="font-bold text-amber-600 hover:text-amber-700 hover:underline cursor-pointer"
                    >
                      Apply to Become a Partner
                    </button>
                  </p>
                </div>

                <div className="pt-4 border-t border-slate-100 flex items-center justify-center text-xs text-slate-500">
                  <button
                    type="button"
                    onClick={() => navigate("/restaurant/auth")}
                    className="hover:text-slate-900 transition-colors flex items-center gap-1.5 cursor-pointer font-medium"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Restaurant Owner Login
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
