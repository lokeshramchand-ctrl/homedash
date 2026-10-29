/** Text wordmark. Swap this component to rebrand the UI. */
export function Logo({ className = '' }: { className?: string }) {
  return <span className={`wordmark ${className}`}>homedash</span>;
}

/** Animated gradient backdrop (CSS only). */
export function BrandSwirl({ className = '', calm = false }: { className?: string; calm?: boolean }) {
  return <div className={`swirl ${calm ? 'calm' : ''} ${className}`} aria-hidden="true" />;
}
