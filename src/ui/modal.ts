import type { User } from '../types';
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

export interface SignInPromptOptions {
  container: HTMLElement;
  /** Opens the sign-in popup. Called from the button's click so it isn't blocked. */
  signIn: () => Promise<User | null>;
  cancel: () => void;
}

/** Explains why sign-in is needed, then waits for the popup to finish. Resolves the signed-in user, or null. */
export function promptForSignIn({ container, signIn, cancel }: SignInPromptOptions): Promise<User | null> {
  return new Promise((resolve) => {
    const status = h('p', { class: 'status', hidden: true });
    const go = h('button', { class: 'btn primary notion-btn', type: 'button' }, h('span', { class: 'notion-mark' }, 'N'), 'Sign in with Notion');
    const dismiss = h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
    const backdrop = h(
      'div',
      { class: 'modal-backdrop' },
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pc-signin-title' },
        h('h2', { id: 'pc-signin-title' }, 'Sign in to comment'),
        h('p', null, 'Comments are saved to Notion. Sign in with your Notion account so your team knows who wrote them.'),
        h('div', { class: 'actions' }, dismiss, go),
        status,
      ),
    );

    let settled = false;
    const close = (user: User | null) => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(user);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      cancel();
      close(null);
    };

    go.addEventListener('click', async () => {
      go.setAttribute('disabled', '');
      status.hidden = false;
      status.textContent = 'Finish signing in in the Notion window…';
      const user = await signIn();
      if (settled) return;
      if (user) return close(user);
      go.removeAttribute('disabled');
      status.textContent = 'Sign-in didn’t finish. Try again?';
    });
    dismiss.addEventListener('click', () => {
      cancel();
      close(null);
    });
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) {
        cancel();
        close(null);
      }
    });
    document.addEventListener('keydown', onKey, true);

    container.append(backdrop);
    requestAnimationFrame(() => go.focus());
  });
}
