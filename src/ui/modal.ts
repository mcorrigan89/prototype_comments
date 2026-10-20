import { h } from './dom';

export interface NamePromptOptions {
  container: HTMLElement;
  currentName?: string;
  onSave: (name: string) => Promise<void>;
}

/** Asks for a display name. Resolves true if one was saved. */
export function promptForName({ container, currentName, onSave }: NamePromptOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const input = h('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Your name',
      maxlength: 60,
      autocomplete: 'name',
      'aria-label': 'Your name',
    });
    input.value = currentName ?? '';
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Continue');
    const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');

    const backdrop = h(
      'div',
      { class: 'modal-backdrop' },
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pc-name-title' },
        h('h2', { id: 'pc-name-title' }, currentName ? 'Change your name' : 'Who’s commenting?'),
        h('p', null, 'Your name is shown on the comments you leave. It’s remembered in this browser.'),
        input,
        h('div', { class: 'actions' }, cancel, save),
      ),
    );

    const close = (saved: boolean) => {
      backdrop.remove();
      resolve(saved);
    };

    async function submit() {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      save.setAttribute('disabled', '');
      await onSave(name);
      close(true);
    }

    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close(false);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void submit();
      if (e.key === 'Escape') close(false);
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    save.addEventListener('click', () => void submit());
    cancel.addEventListener('click', () => close(false));

    container.append(backdrop);
    requestAnimationFrame(() => input.focus());
  });
}
