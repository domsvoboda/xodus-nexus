import { ui } from './i18n';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type Question = { title: string; message: string; confirmLabel?: string };
const Confirmation = createContext<(question: Question) => Promise<boolean>>(async () => false);
export const useConfirmation = () => useContext(Confirmation);

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [question, setQuestion] = useState<Question>();
  const pending = useRef<((answer: boolean) => void)>();
  const mounted = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const choose = (answer: boolean) => { pending.current?.(answer); pending.current = undefined; setQuestion(undefined); };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.(false); pending.current = undefined; };
  }, []);
  useEffect(() => {
    if (!question) return;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.querySelector<HTMLButtonElement>('[data-gamepad-cancel]')?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); choose(false); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (!dialog.current?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => { window.removeEventListener('keydown', keydown, true); if (origin?.isConnected) origin.focus({ preventScroll: true }); };
  }, [question]);
  const ask = (next: Question) => {
    if (!mounted.current || pending.current) return Promise.resolve(false);
    setQuestion(next);
    return new Promise<boolean>(resolve => { pending.current = resolve; });
  };
  return <Confirmation.Provider value={ask}>{children}{question ? <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) choose(false); }}>
    <section ref={dialog} className="game-dialog" role="dialog" aria-modal="true" aria-label={question.title}>
      <h2>{question.title}</h2><p>{question.message}</p>
      <div className="dialog-actions"><button className="secondary" data-gamepad-cancel onClick={() => choose(false)}>{ui("ui.cancel_19766ed")}</button>
        <button className="primary" onClick={() => choose(true)}>{question.confirmLabel ?? ui("ui.continue_31fbef1")}</button></div>
    </section>
  </div> : null}</Confirmation.Provider>;
}
