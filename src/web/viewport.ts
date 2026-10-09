// Event-driven visible viewport sizing. No polling or animation loop.
export function lockParticipantViewport() {
  const root = document.documentElement;
  let frame = 0;
  const size = () => {
    frame = 0;
    const viewport = window.visualViewport;
    root.style.setProperty('--viewport-width', `${viewport?.width ?? innerWidth}px`);
    root.style.setProperty('--viewport-height', `${viewport?.height ?? innerHeight}px`);
    root.style.setProperty('--viewport-left', `${viewport?.offsetLeft ?? 0}px`);
    root.style.setProperty('--viewport-top', `${viewport?.offsetTop ?? 0}px`);
  };
  const resize = () => { if (!frame) frame = requestAnimationFrame(size); };
  const move = (event: TouchEvent) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  };
  size();
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  document.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('scroll', resize);
    document.removeEventListener('touchmove', move);
  }, { once: true });
}
