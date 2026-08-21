import logoMarkWhite from "../../brand/logo-mark-white.png";

export function BrandBadge({ size = 22 }: { size?: 22 | 28 }) {
  return (
    <span className={`brand-badge brand-badge-${size}`} aria-hidden="true">
      <img src={logoMarkWhite} alt="" />
    </span>
  );
}

export function BrandLockup({ size = 22 }: { size?: 22 | 28 }) {
  return (
    <div className="brand-lockup" aria-label="Regenic">
      <BrandBadge size={size} />
      <span>Regenic</span>
    </div>
  );
}
