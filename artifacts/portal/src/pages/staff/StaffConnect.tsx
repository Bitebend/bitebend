import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import { KeyRound, Loader2, ArrowRight, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

interface StaffAuthResponse {
  token: string;
  staff: {
    id: number;
    name: string;
    role: "waiter" | "chef";
    restaurantId: number;
    restaurantName: string;
    restaurantSlug: string;
  };
}

export default function StaffConnect() {
  const [, setLocation] = useLocation();
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  // Auto-redirect if already authenticated and valid
  useEffect(() => {
    const raw = localStorage.getItem("bitebend_staff_auth");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.token && parsed.staff?.role) {
          if (parsed.staff.role === "waiter") {
            setLocation("/staff/waiter");
          } else {
            setLocation("/staff/chef");
          }
        }
      } catch {
        localStorage.removeItem("bitebend_staff_auth");
      }
    }
  }, [setLocation]);

  const handleDigitChange = (index: number, value: string) => {
    // Only accept numeric digit
    const cleaned = value.replace(/\D/g, "");
    if (!cleaned) {
      const copy = [...digits];
      copy[index] = "";
      setDigits(copy);
      return;
    }

    // If pasted full 6 digits
    if (cleaned.length === 6) {
      const newDigits = cleaned.split("").slice(0, 6);
      setDigits(newDigits);
      inputRefs.current[5]?.focus();
      triggerConnect(cleaned);
      return;
    }

    const digit = cleaned[cleaned.length - 1];
    const copy = [...digits];
    copy[index] = digit;
    setDigits(copy);

    // Auto-advance focus to next digit
    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit if all 6 digits are filled
    const fullPin = copy.join("");
    if (fullPin.length === 6) {
      triggerConnect(fullPin);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const triggerConnect = async (pinStr: string) => {
    if (pinStr.length !== 6) return;
    setLoading(true);
    setErrorMsg(null);

    try {
      const data = await apiFetch<StaffAuthResponse>("/api/staff/connect-pin", {
        method: "POST",
        body: JSON.stringify({ pin: pinStr }),
      });

      localStorage.setItem("bitebend_staff_auth", JSON.stringify(data));
      toast.success(`Connected to ${data.staff.restaurantName} as ${data.staff.name}!`);

      if (data.staff.role === "waiter") {
        setLocation("/staff/waiter");
      } else {
        setLocation("/staff/chef");
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Invalid or expired connection PIN. Please ask your manager for a fresh PIN.");
      setDigits(["", "", "", "", "", ""]);
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const pin = digits.join("");
    if (pin.length !== 6) {
      setErrorMsg("Please enter all 6 digits of your connection PIN.");
      return;
    }
    triggerConnect(pin);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-sm space-y-6">
        {/* Brand & Title */}
        <div className="text-center space-y-2">
          <div className="h-14 w-14 rounded-2xl bg-orange-500/10 border border-orange-500/30 text-orange-400 flex items-center justify-center mx-auto shadow-inner">
            <KeyRound className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Bitebend Staff Connection</h1>
          <p className="text-sm text-slate-400">
            Enter the 6-digit connection PIN provided by your restaurant manager.
          </p>
        </div>

        {/* PIN Entry Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="flex justify-center gap-2 sm:gap-3">
            {digits.map((digit, idx) => (
              <input
                key={idx}
                ref={(el) => { inputRefs.current[idx] = el; }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={digit}
                onChange={(e) => handleDigitChange(idx, e.target.value)}
                onKeyDown={(e) => handleKeyDown(idx, e)}
                disabled={loading}
                autoFocus={idx === 0}
                className="w-12 h-14 sm:w-14 sm:h-16 text-center text-2xl font-bold font-mono bg-slate-950/80 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/40 transition-all select-all disabled:opacity-50"
              />
            ))}
          </div>

          {/* Error Message */}
          {errorMsg && (
            <div className="text-xs text-red-400 bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-center">
              {errorMsg}
            </div>
          )}

          {/* Submit Button */}
          <Button
            type="submit"
            disabled={loading || digits.join("").length !== 6}
            className="w-full h-12 bg-orange-600 hover:bg-orange-500 text-white font-semibold rounded-xl flex items-center justify-center gap-2 text-base shadow-lg shadow-orange-950/50 transition-all disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Connecting...
              </>
            ) : (
              <>
                Connect to Restaurant
                <ArrowRight className="h-5 w-5" />
              </>
            )}
          </Button>
        </form>

        {/* Security badge / explainer */}
        <div className="pt-2 border-t border-slate-700/60 text-center">
          <div className="flex items-center justify-center gap-1.5 text-xs text-slate-400 font-medium">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            Zero passwords, zero phone numbers required.
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Connection PINs are one-time use and expire 10 minutes after generation.
          </p>
        </div>
      </div>
    </div>
  );
}
