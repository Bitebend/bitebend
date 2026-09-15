import React, { useState, useMemo } from "react";
import { Link, useLocation } from "wouter";
import {
  Handshake,
  CheckCircle2,
  AlertCircle,
  Loader2,
  TrendingUp,
  ShieldCheck,
  Zap,
  ArrowRight,
  User,
  Mail,
  Phone,
  Lock,
  Eye,
  EyeOff,
  Sparkles,
  MapPin,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { STATE_NAMES, getDistricts } from "@/data/india-states-districts";
import logo from "@/assets/logo.png";

export default function PartnerRegister() {
  const [, setLocation] = useLocation();

  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    state: "",
    city: "",
    password: "",
    confirmPassword: "",
  });

  const districts = useMemo(() => {
    return formData.state ? getDistricts(formData.state) : [];
  }, [formData.state]);

  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<{
    name: string;
    email: string;
    state?: string;
    city?: string;
    message: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!formData.name.trim() || !formData.email.trim() || !formData.phone.trim() || !formData.password.trim()) {
      setError("Please fill in all required fields.");
      return;
    }

    if (formData.password.length < 6) {
      setError("Password must be at least 6 characters long.");
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch<{
        success: boolean;
        message: string;
        partner: { id: number; name: string; email: string; state?: string; city?: string; status: string };
      }>("/partner/register", {
        method: "POST",
        body: JSON.stringify({
          name: formData.name.trim(),
          email: formData.email.trim(),
          phone: formData.phone.trim(),
          state: formData.state.trim() || undefined,
          city: formData.city.trim() || undefined,
          password: formData.password,
        }),
      });

      setSuccessData({
        name: res.partner?.name || formData.name,
        email: res.partner?.email || formData.email,
        state: res.partner?.state || formData.state,
        city: res.partner?.city || formData.city,
        message: res.message || "Your partner application has been submitted successfully.",
      });
    } catch (err: any) {
      console.error("[PartnerRegister] Submission error:", err);
      setError(err.message || "Failed to submit partner application. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-amber-50/60 via-orange-50/20 to-slate-50 text-slate-900 flex flex-col justify-between selection:bg-amber-500 selection:text-white font-sans">
      {/* Top Navigation */}
      <header className="border-b border-amber-100 bg-white/90 backdrop-blur-md sticky top-0 z-50 shadow-2xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <img
              src={logo}
              alt="Bitebend"
              className="w-9 h-9 object-contain"
            />
            <div className="flex items-center gap-2">
              <span className="font-black text-xl tracking-tight text-slate-900">
                Bitebend
              </span>
              <span className="text-amber-800 text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 border border-amber-200">
                Partners
              </span>
            </div>
          </Link>

          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 hidden sm:inline">Already registered?</span>
            <Link
              href="/partner/login"
              className="text-xs font-bold text-amber-700 hover:text-amber-800 px-3.5 py-1.5 rounded-lg border border-amber-300 hover:border-amber-400 bg-amber-50 hover:bg-amber-100 transition-all shadow-2xs"
            >
              Sign In to Portal
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-16 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        {/* Left Column: Value Proposition & Partner Benefits */}
        <div className="lg:col-span-6 space-y-8">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-amber-100/90 border border-amber-200 text-amber-800 text-xs font-bold shadow-2xs">
              <Sparkles className="w-3.5 h-3.5 text-amber-600" />
              <span>Channel Partner Program</span>
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-slate-900 tracking-tight leading-[1.15]">
              Grow with Bitebend. <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-600 via-orange-600 to-amber-700">
                Earn Recurring Revenue.
              </span>
            </h1>
            <p className="text-slate-600 text-base sm:text-lg leading-relaxed max-w-xl">
              Partner with Bitebend to digitize restaurants across your city. Earn recurring lifetime commissions on every restaurant subscription you onboard.
            </p>
          </div>

          {/* Key Program Highlights - Clean Light Cards with Orange/Amber Highlights */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div className="p-4.5 rounded-xl bg-white border border-slate-200/90 shadow-xs space-y-2 hover:border-amber-300 transition-colors">
              <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center font-bold">
                <TrendingUp className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-slate-900">Recurring Commission</h3>
              <p className="text-xs text-slate-600 leading-normal">
                Earn recurring commission payouts on every initial subscription and continuous plan renewal.
              </p>
            </div>

            <div className="p-4.5 rounded-xl bg-white border border-slate-200/90 shadow-xs space-y-2 hover:border-amber-300 transition-colors">
              <div className="w-8 h-8 rounded-lg bg-orange-100 text-orange-700 flex items-center justify-center font-bold">
                <Zap className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-slate-900">Official Referral Code</h3>
              <p className="text-xs text-slate-600 leading-normal">
                Receive an official branded referral code and dedicated invitation link upon partner approval.
              </p>
            </div>

            <div className="p-4.5 rounded-xl bg-white border border-slate-200/90 shadow-xs space-y-2 hover:border-amber-300 transition-colors">
              <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-700 flex items-center justify-center font-bold">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-slate-900">Authoritative Attribution</h3>
              <p className="text-xs text-slate-600 leading-normal">
                Permanent attribution tied securely in the Bitebend database to your verified partner account.
              </p>
            </div>

            <div className="p-4.5 rounded-xl bg-white border border-slate-200/90 shadow-xs space-y-2 hover:border-amber-300 transition-colors">
              <div className="w-8 h-8 rounded-lg bg-orange-50 text-orange-700 flex items-center justify-center font-bold">
                <CheckCircle2 className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-slate-900">Real-Time Portal</h3>
              <p className="text-xs text-slate-600 leading-normal">
                Track attributed outlets, renewal milestones, and direct bank payouts directly in your dashboard.
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: Registration Card or Success State */}
        <div className="lg:col-span-6">
          <div className="bg-white border border-amber-100/90 rounded-2xl shadow-xl overflow-hidden relative">
            {/* Top Accent Gradient Bar matching Bitebend Theme */}
            <div className="h-2 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600" />

            <div className="p-6 sm:p-8">
              {successData ? (
                /* Success Submission Screen */
                <div className="text-center py-4 space-y-6 animate-in fade-in zoom-in-95 duration-300">
                  <div className="w-16 h-16 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 flex items-center justify-center mx-auto shadow-sm">
                    <CheckCircle2 className="w-8 h-8" />
                  </div>

                  <div className="space-y-2">
                    <h2 className="text-2xl font-bold text-slate-900 tracking-tight">
                      Application Submitted!
                    </h2>
                    <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
                      Thank you, <strong className="text-slate-900">{successData.name}</strong>. Your Bitebend Channel Partner application has been received and is currently under review by our operations team.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-amber-50/40 border border-amber-100 text-left space-y-2.5 text-xs text-slate-700">
                    <div className="flex justify-between border-b border-amber-100 pb-2">
                      <span className="text-slate-500">Account Email:</span>
                      <span className="font-mono text-slate-900 font-medium">{successData.email}</span>
                    </div>
                    {(successData.city || successData.state) && (
                      <div className="flex justify-between border-b border-amber-100 pb-2">
                        <span className="text-slate-500">Location:</span>
                        <span className="text-slate-900 font-semibold">
                          {[successData.city, successData.state].filter(Boolean).join(", ")}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between border-b border-amber-100 pb-2">
                      <span className="text-slate-500">Application Status:</span>
                      <span className="px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold border border-amber-200 text-[11px]">
                        Pending Review
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Referral Code:</span>
                      <span className="text-slate-500 italic">Assigned upon Super Admin approval (BBP-XXXXXX)</span>
                    </div>
                  </div>

                  <div className="pt-2 space-y-3">
                    <Link
                      href="/partner/login"
                      className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-gradient-to-r from-amber-600 via-orange-600 to-amber-700 hover:from-amber-700 hover:to-orange-700 text-white font-bold text-sm transition-all shadow-md shadow-orange-500/20 cursor-pointer"
                    >
                      <span>Proceed to Partner Sign In</span>
                      <ArrowRight className="w-4 h-4" />
                    </Link>
                    <p className="text-[11px] text-slate-500">
                      You can log in anytime to check your real-time application and approval status.
                    </p>
                  </div>
                </div>
              ) : (
                /* Application Form */
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center font-bold shrink-0">
                        <Handshake className="w-4 h-4" />
                      </div>
                      <h2 className="text-xl font-bold text-slate-900 tracking-tight">
                        Apply as a Channel Partner
                      </h2>
                    </div>
                    <p className="text-xs text-slate-500">
                      Submit your details below to register. No upfront cost or commitment required.
                    </p>
                  </div>

                  {error && (
                    <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2.5">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
                      <span>{error}</span>
                    </div>
                  )}

                  <div className="space-y-3 pt-2">
                    {/* Full Name */}
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-slate-400" />
                        <span>Full Name *</span>
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Rahul Sharma"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 outline-none text-sm text-slate-900 placeholder:text-slate-400 transition-all"
                      />
                    </div>

                    {/* Email Address */}
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                        <Mail className="w-3.5 h-3.5 text-slate-400" />
                        <span>Email Address (Login ID) *</span>
                      </label>
                      <input
                        type="email"
                        required
                        placeholder="e.g. rahul@example.com"
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 outline-none text-sm text-slate-900 placeholder:text-slate-400 transition-all"
                      />
                    </div>

                    {/* Phone Number */}
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                        <Phone className="w-3.5 h-3.5 text-slate-400" />
                        <span>Mobile Contact Number *</span>
                      </label>
                      <input
                        type="tel"
                        required
                        placeholder="e.g. 9876543210"
                        value={formData.phone}
                        onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 outline-none text-sm text-slate-900 placeholder:text-slate-400 transition-all"
                      />
                    </div>

                    {/* State and City / District */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 text-slate-400" />
                          <span>State *</span>
                        </label>
                        <select
                          required
                          value={formData.state}
                          onChange={(e) => {
                            const newState = e.target.value;
                            setFormData({ ...formData, state: newState, city: "" });
                          }}
                          className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 outline-none text-sm text-slate-900 transition-all cursor-pointer"
                        >
                          <option value="" className="text-slate-400">Select State...</option>
                          {STATE_NAMES.map((s) => (
                            <option key={s} value={s} className="text-slate-900">
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 text-slate-400" />
                          <span>City / District *</span>
                        </label>
                        <input
                          type="text"
                          required
                          list="partner-city-datalist"
                          placeholder={formData.state ? "Enter or select city" : "Enter city"}
                          value={formData.city}
                          onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                          className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 outline-none text-sm text-slate-900 placeholder:text-slate-400 transition-all"
                        />
                        {districts.length > 0 && (
                          <datalist id="partner-city-datalist">
                            {districts.map((d) => (
                              <option key={d} value={d} />
                            ))}
                          </datalist>
                        )}
                      </div>
                    </div>

                    {/* Password & Confirm Password */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                          <Lock className="w-3.5 h-3.5 text-slate-400" />
                          <span>Password *</span>
                        </label>
                        <div className="relative">
                          <input
                            type={showPassword ? "text" : "password"}
                            required
                            placeholder="Min 6 characters"
                            value={formData.password}
                            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                            className="w-full px-3.5 py-2.5 pr-9 rounded-lg bg-white border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 outline-none text-sm text-slate-900 placeholder:text-slate-400 transition-all"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                          >
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                          <Lock className="w-3.5 h-3.5 text-slate-400" />
                          <span>Confirm Password *</span>
                        </label>
                        <input
                          type={showPassword ? "text" : "password"}
                          required
                          placeholder="Re-enter password"
                          value={formData.confirmPassword}
                          onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                          className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 outline-none text-sm text-slate-900 placeholder:text-slate-400 transition-all"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 space-y-3">
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-gradient-to-r from-amber-600 via-orange-600 to-amber-700 hover:from-amber-700 hover:to-orange-700 text-white font-bold text-sm transition-all shadow-md shadow-orange-500/20 disabled:opacity-50 cursor-pointer"
                    >
                      {loading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Submitting Application...</span>
                        </>
                      ) : (
                        <>
                          <span>Submit Partner Application</span>
                          <ArrowRight className="w-4 h-4" />
                        </>
                      )}
                    </button>

                    <div className="text-center">
                      <span className="text-xs text-slate-500">
                        By registering, you agree to Bitebend's Partner Terms of Service and Code of Conduct.
                      </span>
                    </div>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-amber-100 bg-white py-6 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>&copy; {new Date().getFullYear()} Bitebend Inc. All rights reserved.</span>
          <div className="flex items-center gap-4">
            <Link href="/" className="hover:text-slate-800">Home</Link>
            <Link href="/partner/login" className="hover:text-slate-800">Partner Login</Link>
            <Link href="/restaurant/register" className="hover:text-slate-800">Restaurant Registration</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
