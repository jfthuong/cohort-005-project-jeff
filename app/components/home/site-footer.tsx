import { PAGE_WIDTH } from "./page-width";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div
        className={`${PAGE_WIDTH} flex items-center justify-between py-8 text-sm text-muted-foreground`}
      >
        <span className="font-semibold text-foreground">Cadence</span>
        <span>Learn at your own pace</span>
      </div>
    </footer>
  );
}
