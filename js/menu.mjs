const dialog = document.getElementById('app-menu');
let opener;
export function openMenu(trigger) {
  if (dialog.open) return;
  opener = trigger || document.activeElement;
  dialog.showModal(); document.body.classList.add('menu-open');
}
export function closeMenu() { dialog.close(); }
document.querySelectorAll('[data-open-menu]').forEach(button => button.addEventListener('click', () => openMenu(button)));
document.getElementById('close-menu').addEventListener('click', closeMenu);
dialog.addEventListener('close', () => { document.body.classList.remove('menu-open'); opener?.focus(); });
dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeMenu();
});
