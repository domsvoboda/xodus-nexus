import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children' | 'className'> & {
  label: ReactNode;
  description?: ReactNode;
  className?: string;
};

/** Native input semantics with one labelled hit area for pointer, keyboard and pad. */
export function CheckField({ label, description, className = '', ...input }: Props) {
  const id = useId();
  return <label className={`check-field ${input.role === 'switch' ? 'check-switch ' : ''}${className}`}>
    <input type="checkbox" {...input} className="check-input" aria-labelledby={`${id}-label`} aria-describedby={description ? `${id}-help` : undefined} />
    <span className="check-copy"><span id={`${id}-label`}>{label}</span>{description ? <small id={`${id}-help`}>{description}</small> : null}</span>
  </label>;
}
