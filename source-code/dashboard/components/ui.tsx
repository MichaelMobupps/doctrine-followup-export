import React, { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  size?: "sm" | "default" | "lg" | "icon";
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", isLoading, children, disabled, ...props }, ref) => {
    // B9d.2: refined variants — shadow + focus rings on primary CTAs,
    // proper secondary vs outline differentiation, accent-tinted focus.
    const variants = {
      // B9d.4: text-[var(--accent-foreground)] enables per-product text-color on accent bg (white on blue, dark on amber).
      // B9d.5: hover lifts a soft accent-tinted halo (--accent-glow) for premium CTA feel.
      default: "bg-[var(--accent)] text-[var(--accent-foreground)] border border-[var(--accent)] shadow-sm hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)] hover:shadow-[0_4px_24px_var(--accent-glow)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]",
      secondary: "bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border-default)] hover:bg-[var(--bg-elevated)] hover:border-[var(--border-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
      outline: "bg-transparent text-[var(--text-secondary)] border border-[var(--border-default)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] hover:bg-[var(--bg-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
      ghost: "bg-transparent text-[var(--text-tertiary)] border border-transparent hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
      destructive: "bg-transparent text-[var(--danger)] border border-[var(--danger-border)] hover:bg-[var(--danger-muted)] hover:border-[var(--danger)] focus-visible:ring-2 focus-visible:ring-[var(--danger)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]",
    };

    const sizes = {
      sm: "h-8 px-3 text-[12px]",
      default: "h-9 px-4 text-[13px]",
      lg: "h-10 px-5 text-[13px]",
      icon: "h-9 w-9 flex items-center justify-center",
    };

    return (
      <button
        ref={ref}
        disabled={isLoading || disabled}
        className={cn(
          // B9d.2: smoother 200ms transition + better disabled state.
          "inline-flex items-center justify-center font-medium rounded-md transition-all duration-200 focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none active:scale-[0.98]",
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      >
        {isLoading ? (
          <span className="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : null}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";

// B9d.3: subtle shadow for depth - visible on AG white bg, near-invisible on dark themes.
// B9d.6: rounded-xl + always-on subtle hover lift.
// B9d.8: motion-converted with variants - inherits hidden/visible state from
// the App.tsx page motion.div, cascading in via staggerChildren. Hover-lift
// moved from CSS to whileHover to avoid clash with variant-driven transform.
// B9d.11-revert: 3D cursor-tracked tilt removed. Visual distortion on wide
// content cards (table-heavy pages) outweighed the premium feel. Back to
// flat whileHover lift.
const cardVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" as const } },
};

// B10.8: Card accepts framer-motion `initial` passthrough so callers can
// pass `initial={false}` to skip the cardVariants entrance animation.
export const Card = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement> & { initial?: any }) => (
  <motion.div
    variants={cardVariants}
    whileHover={{ y: -1 }}
    transition={{ type: "spring", stiffness: 400, damping: 30 }}
    className={cn(
      "rounded-xl shadow-sm",
      "transition-shadow duration-300 ease-out",
      "hover:shadow-md",
      className
    )}
    style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
    {...(props as any)}
  />
);
export const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1 p-5", className)} {...props} />
);
export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3
    className={cn("font-semibold leading-none", className)}
    style={{ fontSize: "13px", letterSpacing: "0" }}
    {...props}
  />
);
export const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("p-5 pt-0", className)} {...props} />
);

export const Badge = ({ className, variant = "default", ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "success" | "warning" | "destructive" | "outline" | "secondary" }) => {
  const variants = {
    default: "bg-[var(--accent-muted)] text-[var(--accent)]",
    secondary: "bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]",
    success: "bg-[var(--success-muted)] text-[var(--success)]",
    warning: "bg-[var(--warning-muted)] text-[var(--warning)]",
    destructive: "bg-[var(--danger-muted)] text-[var(--danger)]",
    outline: "text-[var(--text-secondary)] border border-[var(--border-default)]",
  };
  return (
    <div
      className={cn(
        // B9d.3: pill shape + slight padding bump for modern indicator feel.
        "inline-flex items-center rounded-full px-2.5 py-0.5 font-medium font-mono",
        variants[variant],
        className
      )}
      style={{ fontSize: "11px" }}
      {...props}
    />
  );
};

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return (
      // B9d.3: focus state via CSS classes - replaces inline onFocus/onBlur style mutation.
      <input
        ref={ref}
        className={cn(
          "flex h-9 w-full rounded-md px-3 py-2 text-[13px] transition-all duration-200",
          "bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-default)]",
          "placeholder:text-[var(--text-tertiary)]",
          "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-muted)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => {
    return (
      // B9d.3: focus state via CSS classes - replaces inline onFocus/onBlur style mutation.
      <select
        ref={ref}
        className={cn(
          "flex h-9 w-full appearance-none rounded-md px-3 py-2 text-[13px] transition-all duration-200",
          "bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-default)]",
          "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-muted)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    );
  }
);
Select.displayName = "Select";

export const Table = ({ className, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
  <div className="w-full overflow-auto">
    <table className={cn("w-full caption-bottom text-[13px]", className)} {...props} />
  </div>
);
export const TableHeader = ({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn("", className)} style={{ borderBottom: "1px solid var(--border-default)" }} {...props} />
);
export const TableBody = ({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
);
export const TableRow = ({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => (
  <tr
    className={cn("transition-colors duration-100 hover:bg-[var(--bg-tertiary)]", className)}
    style={{ borderBottom: "1px solid var(--border-default)" }}
    {...props}
  />
);
export const TableHead = ({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    className={cn("h-9 px-4 text-left align-middle font-medium uppercase tracking-[0.04em]", className)}
    style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
    {...props}
  />
);
export const TableCell = ({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td
    className={cn("px-4 align-middle", className)}
    style={{ minHeight: "44px", padding: "12px 16px", color: "var(--text-primary)" }}
    {...props}
  />
);

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}
export function Modal({ isOpen, onClose, title, description, children }: ModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-50"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            {/* B9d.6: spring physics + scale-in for premium modal entrance */}
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ type: "spring", stiffness: 350, damping: 28 }}
              className="w-full max-w-lg overflow-hidden rounded-xl p-5 pointer-events-auto"
              style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
                boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
              }}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-semibold" style={{ fontSize: "14px", color: "var(--text-primary)" }}>{title}</h2>
                  {description && <p className="text-[13px] mt-1" style={{ color: "var(--text-secondary)" }}>{description}</p>}
                </div>
                <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 -mr-2">
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div>{children}</div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
