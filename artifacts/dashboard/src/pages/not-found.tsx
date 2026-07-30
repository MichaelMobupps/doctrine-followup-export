import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center text-center">
      <AlertCircle className="h-6 w-6 mb-3" style={{ color: "var(--danger)" }} />
      <h2 className="font-semibold" style={{ fontSize: "14px" }}>404 Page Not Found</h2>
      <p className="text-[13px] mt-2" style={{ color: "var(--text-secondary)" }}>
        This page does not exist.
      </p>
    </div>
  );
}
