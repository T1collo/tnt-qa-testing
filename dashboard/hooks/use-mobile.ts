import * as React from "react"

const MOBILE_BREAKPOINT = 768

// useSyncExternalStore instead of the old effect+setState pattern: it's the API React
// actually ships for subscribing to external browser state (handles SSR/hydration via
// getServerSnapshot natively), and it sidesteps react-hooks' set-state-in-effect check
// entirely rather than fighting it.
function subscribe(callback: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

function getServerSnapshot() {
  return false
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
