import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Panel: the one card template for every dashboard section.
 * Header = icon + title + subtitle on the left, an optional action on the right.
 * `tone` tints the border for alarm states; `index` staggers the entrance animation.
 */
export function Panel({
  title,
  subtitle,
  icon,
  action,
  tone,
  index,
  className,
  bodyClassName,
  children,
  ...props
}: {
  title: ReactNode;
  subtitle?: ReactNode | undefined;
  icon?: ReactNode | undefined;
  action?: ReactNode | undefined;
  tone?: "ok" | "warn" | "fail" | undefined;
  index?: number | undefined;
  className?: string | undefined;
  bodyClassName?: string | undefined;
  children: ReactNode;
} & Omit<ComponentProps<"section">, "title">) {
  return (
    <section
      data-slot="panel"
      data-tone={tone}
      className={cn("panel", className)}
      style={index == null ? undefined : ({ "--i": index } as CSSProperties)}
      aria-label={typeof title === "string" ? title : undefined}
      {...props}
    >
      <PanelHeader title={title} subtitle={subtitle} icon={icon} action={action} />
      <div data-slot="panel-body" className={cn("panel-body", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

export function PanelHeader({
  title,
  subtitle,
  icon,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode | undefined;
  icon?: ReactNode | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <header data-slot="panel-header" className="panel-header">
      <div className="panel-heading">
        {icon && (
          <span className="panel-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <div className="panel-titles">
          <h2 className="panel-title">{title}</h2>
          {subtitle && <p className="panel-subtitle">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="panel-action">{action}</div>}
    </header>
  );
}

/** Bordered sub-surface inside a Panel (node tile, spend card, model card). */
export function Tile({
  className,
  tone,
  ...props
}: ComponentProps<"article"> & { tone?: "ok" | "warn" | "fail" | undefined }) {
  return <article data-slot="tile" data-tone={tone} className={cn("tile", className)} {...props} />;
}
