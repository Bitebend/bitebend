import React, { useState, useEffect, useMemo } from "react";
import {
  User,
  CreditCard,
  Building2,
  Copy,
  Check,
  Save,
  ShieldCheck,
  Percent,
  MapPin,
  FileText,
  BadgeCheck,
  Calendar,
  Phone,
  Mail,
  KeyRound,
  Eye,
  EyeOff,
  Lock,
  AlertCircle,
} from "lucide-react";
import type { PartnerProfile } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { STATE_NAMES, getDistricts } from "@/data/india-states-districts";

interface PartnerProfileTabProps {
  partner: PartnerProfile;
  onRefresh?: () => void;
  onProfileUpdated?: () => void;
}

export function PartnerProfileTab({ partner, onRefresh, onProfileUpdated }: PartnerProfileTabProps) {
  const { toast } = useToast();

  const handleRefresh = () => {
    if (onRefresh) onRefresh();
    if (onProfileUpdated) onProfileUpdated();
  };

  // Basic Info Form State
  const [name, setName] = useState(partner.name || "");
  const [phone, setPhone] = useState(partner.phone || "");
  const [state, setState] = useState(partner.state || "");
  const [city, setCity] = useState(partner.city || "");
  const [savingProfile, setSavingProfile] = useState(false);

  // Sync state when partner prop changes
  useEffect(() => {
    setName(partner.name || "");
    setPhone(partner.phone || "");
    setState(partner.state || "");
    setCity(partner.city || "");
  }, [partner]);

  const districts = useMemo(() => {
    return state ? getDistricts(state) : [];
  }, [state]);

  // Payout Details Form State
  const [accountName, setAccountName] = useState(partner.payoutDetails?.accountName || "");
  const [accountNumber, setAccountNumber] = useState(partner.payoutDetails?.accountNumber || "");
  const [ifsc, setIfsc] = useState(partner.payoutDetails?.ifsc || "");
  const [bankName, setBankName] = useState(partner.payoutDetails?.bankName || "");
  const [savingPayout, setSavingPayout] = useState(false);

  // Password Security Form State
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPass, setShowCurrentPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passError, setPassError] = useState("");
  const [passSuccess, setPassSuccess] = useState(false);

  useEffect(() => {
    setAccountName(partner.payoutDetails?.accountName || "");
    setAccountNumber(partner.payoutDetails?.accountNumber || "");
    setIfsc(partner.payoutDetails?.ifsc || "");
    setBankName(partner.payoutDetails?.bankName || "");
  }, [partner.payoutDetails]);

  const [copied, setCopied] = useState(false);
  const referralUrl = partner.referralCode
    ? `${window.location.origin}/partner/${partner.referralCode}/register`
    : "";

  const handleCopyLink = () => {
    if (!referralUrl) return;
    navigator.clipboard.writeText(referralUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      await apiFetch("/partner/profile", {
        method: "PUT",
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          state: state.trim() || undefined,
          city: city.trim() || undefined,
        }),
      });
      toast({
        title: "Profile Updated",
        description: "Your contact and location details have been saved successfully.",
      });
      handleRefresh();
    } catch (err: any) {
      toast({
        title: "Update Failed",
        description: err.message || "Failed to update profile",
        variant: "destructive",
      });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassError("");
    setPassSuccess(false);

    if (!currentPassword.trim()) {
      setPassError("Please enter your current password.");
      return;
    }
    if (!newPassword.trim() || newPassword.trim().length < 6) {
      setPassError("New password must be at least 6 characters long.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPassError("New password and confirm password do not match.");
      return;
    }

    setChangingPassword(true);
    try {
      await apiFetch("/partner/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: currentPassword.trim(),
          newPassword: newPassword.trim(),
        }),
      });

      setPassSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({
        title: "Password Updated Successfully",
        description: "Your partner portal login password has been changed.",
      });
    } catch (err: any) {
      setPassError(err.message || "Failed to change password. Ensure your current password is correct.");
      toast({
        title: "Password Change Failed",
        description: err.message || "Please check your current password and try again.",
        variant: "destructive",
      });
    } finally {
      setChangingPassword(false);
    }
  };

  const handleSavePayout = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPayout(true);
    try {
      await apiFetch("/partner/payout-details", {
        method: "PUT",
        body: JSON.stringify({
          accountName: accountName.trim() || null,
          accountNumber: accountNumber.trim() || null,
          ifsc: ifsc.trim() || null,
          bankName: bankName.trim() || null,
        }),
      });
      toast({
        title: "Payout Settings Saved",
        description: "Your bank payout details have been updated.",
      });
      handleRefresh();
    } catch (err: any) {
      toast({
        title: "Update Failed",
        description: err.message || "Failed to save payout settings",
        variant: "destructive",
      });
    } finally {
      setSavingPayout(false);
    }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Partner Profile & Settings</h2>
        <p className="text-sm text-slate-500">
          View your verified partner records, geographic location, commission terms, and configure direct bank payout credentials.
        </p>
      </div>

      {/* ── SUMMARY TABLE 1: PARTNER PROFILE & LOCATION DETAILS ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center font-bold">
              <User className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Partner Details & Registered Location</h3>
              <p className="text-xs text-slate-500">Official partner identity and geographical jurisdiction</p>
            </div>
          </div>
          <span
            className={`px-3 py-1 rounded-full text-xs font-bold border capitalize ${
              partner.status === "active"
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : partner.status === "pending"
                ? "bg-amber-50 text-amber-700 border-amber-200"
                : "bg-rose-50 text-rose-700 border-rose-200"
            }`}
          >
            {partner.status} Account
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <tbody className="divide-y divide-slate-100 text-slate-700">
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 w-1/3 bg-slate-50/30">Partner Full Name</td>
                <td className="px-5 py-3.5 font-bold text-slate-900">{partner.name || "—"}</td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 bg-slate-50/30">Registered Email (Login ID)</td>
                <td className="px-5 py-3.5 font-mono text-slate-800">{partner.email || "—"}</td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 bg-slate-50/30">Mobile Contact Number</td>
                <td className="px-5 py-3.5 text-slate-800">{partner.phone || "—"}</td>
              </tr>
              <tr className="hover:bg-slate-50/50 bg-amber-50/20">
                <td className="px-5 py-3.5 font-semibold text-slate-700 bg-amber-50/40">
                  <div className="flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-amber-600" />
                    <span>State</span>
                  </div>
                </td>
                <td className="px-5 py-3.5 font-bold text-slate-900">
                  {partner.state ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-amber-100/70 text-amber-900 font-semibold border border-amber-200">
                      {partner.state}
                    </span>
                  ) : (
                    <span className="text-slate-400 italic">Not set</span>
                  )}
                </td>
              </tr>
              <tr className="hover:bg-slate-50/50 bg-amber-50/20">
                <td className="px-5 py-3.5 font-semibold text-slate-700 bg-amber-50/40">
                  <div className="flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-amber-600" />
                    <span>City / District</span>
                  </div>
                </td>
                <td className="px-5 py-3.5 font-bold text-slate-900">
                  {partner.city ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-amber-100/70 text-amber-900 font-semibold border border-amber-200">
                      {partner.city}
                    </span>
                  ) : (
                    <span className="text-slate-400 italic">Not set</span>
                  )}
                </td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 bg-slate-50/30">Partner Member Since</td>
                <td className="px-5 py-3.5 text-slate-600">
                  {partner.createdAt
                    ? new Date(partner.createdAt).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── SUMMARY TABLE 2: PROGRAM TERMS & BANKING OVERVIEW ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Partner Program Terms & Banking Overview</h3>
              <p className="text-xs text-slate-500">Commission rate, referral link, and bank account for payouts</p>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <tbody className="divide-y divide-slate-100 text-slate-700">
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 w-1/3 bg-slate-50/30">Commission Rate</td>
                <td className="px-5 py-3.5">
                  <span className="inline-flex items-center gap-1 font-bold text-emerald-700 text-sm">
                    <Percent className="w-3.5 h-3.5 text-emerald-600" />
                    <span>{partner.commissionPercentage}% Recurring</span>
                  </span>
                  <span className="text-[11px] text-slate-400 ml-2">
                    (Applicable on all initial & renewal subscriptions)
                  </span>
                </td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 bg-slate-50/30">Referral Code</td>
                <td className="px-5 py-3.5">
                  {partner.referralCode ? (
                    <div className="inline-flex items-center gap-2">
                      <span className="font-mono text-xl sm:text-2xl font-extrabold text-amber-950 bg-amber-50 px-3.5 py-1.5 rounded-lg border border-amber-300 tracking-wider shadow-2xs">
                        {partner.referralCode}
                      </span>
                    </div>
                  ) : (
                    <span className="text-slate-400 italic">Generated upon Super Admin approval</span>
                  )}
                </td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 bg-slate-50/30">Dedicated Referral Link</td>
                <td className="px-5 py-3.5">
                  {partner.referralCode ? (
                    <div className="flex items-center gap-2 max-w-lg">
                      <span className="font-mono text-[11px] text-slate-700 bg-slate-50 px-2.5 py-1 rounded border border-slate-200 truncate flex-1">
                        {referralUrl}
                      </span>
                      <button
                        onClick={handleCopyLink}
                        className="px-2.5 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-bold flex items-center gap-1 shrink-0 cursor-pointer"
                      >
                        {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copied ? "Copied" : "Copy"}</span>
                      </button>
                    </div>
                  ) : (
                    <span className="text-slate-400 italic">Available once account is approved</span>
                  )}
                </td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 bg-slate-50/30">Bank Account Holder</td>
                <td className="px-5 py-3.5 font-medium text-slate-900">
                  {partner.payoutDetails?.accountName || <span className="text-slate-400 italic">Not configured</span>}
                </td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 bg-slate-50/30">Bank Name</td>
                <td className="px-5 py-3.5 text-slate-800">
                  {partner.payoutDetails?.bankName || <span className="text-slate-400 italic">Not configured</span>}
                </td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 bg-slate-50/30">Bank Account Number</td>
                <td className="px-5 py-3.5 font-mono text-slate-800">
                  {partner.payoutDetails?.accountNumber || <span className="text-slate-400 italic">Not configured</span>}
                </td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-5 py-3.5 font-semibold text-slate-500 bg-slate-50/30">IFSC Code</td>
                <td className="px-5 py-3.5 font-mono uppercase text-slate-800">
                  {partner.payoutDetails?.ifsc || <span className="text-slate-400 italic">Not configured</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── EDITABLE FORM 1: PERSONAL & LOCATION INFO ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs p-6 space-y-6">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center">
              <User className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Update Profile & Location</h3>
              <p className="text-xs text-slate-500">Edit your display name, contact phone number, and operating location</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Partner Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Email Address (Login ID)
              </label>
              <input
                type="email"
                disabled
                value={partner.email}
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed"
              />
              <p className="text-[10px] text-slate-400 mt-1">To change login email, contact super admin.</p>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Phone Number *
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                State
              </label>
              <select
                value={state}
                onChange={(e) => {
                  const newState = e.target.value;
                  setState(newState);
                  setCity("");
                }}
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent bg-white cursor-pointer"
              >
                <option value="">Select State...</option>
                {STATE_NAMES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                City / District
              </label>
              <input
                type="text"
                list="profile-city-datalist"
                placeholder={state ? "Enter or select city" : "Enter city"}
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              />
              {districts.length > 0 && (
                <datalist id="profile-city-datalist">
                  {districts.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              )}
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={savingProfile}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-xs transition-colors disabled:opacity-60 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              <span>{savingProfile ? "Updating..." : "Save Profile & Location"}</span>
            </button>
          </div>
        </form>
      </div>

      {/* ── EDITABLE FORM 2: BANK ACCOUNT PAYOUT DETAILS (NO UPI) ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs p-6 space-y-6">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <CreditCard className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Bank Account Payout Details</h3>
              <p className="text-xs text-slate-500">Provide bank account details for direct commission disbursements (NEFT/RTGS/IMPS)</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSavePayout} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Account Holder Name
              </label>
              <input
                type="text"
                placeholder="Full name as on bank passbook"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Bank Name
              </label>
              <input
                type="text"
                placeholder="e.g. HDFC Bank, ICICI Bank, SBI"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Bank Account Number
              </label>
              <input
                type="text"
                placeholder="Enter account number"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                IFSC Code
              </label>
              <input
                type="text"
                placeholder="e.g. HDFC0001234"
                value={ifsc}
                onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono uppercase"
              />
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={savingPayout}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-xs transition-colors disabled:opacity-60 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              <span>{savingPayout ? "Saving..." : "Save Payout Details"}</span>
            </button>
          </div>
        </form>
      </div>

      {/* ── EDITABLE FORM 3: PASSWORD & LOGIN SECURITY ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs p-6 space-y-6">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
              <KeyRound className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Partner Login & Password Security</h3>
              <p className="text-xs text-slate-500">Update your partner portal login password or review your login ID</p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>End-to-End Encrypted</span>
          </div>
        </div>

        {passSuccess && (
          <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2 font-medium">
            <Check className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Your password was successfully updated. You can now use your new password on your next login.</span>
          </div>
        )}

        {passError && (
          <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2 font-medium">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{passError}</span>
          </div>
        )}

        <form onSubmit={handleChangePassword} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Current Password *
              </label>
              <div className="relative">
                <input
                  type={showCurrentPass ? "text" : "password"}
                  placeholder="Enter current password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className="w-full text-xs sm:text-sm px-3.5 py-2.5 pr-10 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPass(!showCurrentPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  tabIndex={-1}
                >
                  {showCurrentPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                New Password *
              </label>
              <div className="relative">
                <input
                  type={showNewPass ? "text" : "password"}
                  placeholder="Min 6 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                  className="w-full text-xs sm:text-sm px-3.5 py-2.5 pr-10 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPass(!showNewPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  tabIndex={-1}
                >
                  {showNewPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Confirm New Password *
              </label>
              <div className="relative">
                <input
                  type={showConfirmPass ? "text" : "password"}
                  placeholder="Re-type new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                  className="w-full text-xs sm:text-sm px-3.5 py-2.5 pr-10 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPass(!showConfirmPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  tabIndex={-1}
                >
                  {showConfirmPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-200">
            <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span>Forgot your current password? Contact Bitebend Admin for an instant temporary password reset.</span>
            </div>
            <button
              type="submit"
              disabled={changingPassword}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-xs transition-colors disabled:opacity-60 cursor-pointer shrink-0"
            >
              <KeyRound className="w-4 h-4" />
              <span>{changingPassword ? "Updating..." : "Update Password"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
