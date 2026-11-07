/**
 * 라이트/다크 테마 적용. 패널과 설정 화면이 함께 씁니다.
 *
 *  - 'system' 이면 <html data-theme> 를 지워 운영체제 설정(prefers-color-scheme)을 따릅니다.
 *  - 'light' / 'dark' 이면 그 값으로 고정합니다. 색 정의는 각 화면의 CSS 에 있습니다.
 */

const darkQuery = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/** 지금 화면에 실제로 보이는 테마('light' | 'dark'). */
export function effectiveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return darkQuery()?.matches ? 'dark' : 'light';
}

/** 토글 버튼을 눌렀을 때 고를 다음 테마 — 보이는 것의 반대로 고정합니다. */
export const nextTheme = (theme) => (effectiveTheme(theme) === 'dark' ? 'light' : 'dark');

export function applyTheme(theme, root = document.documentElement) {
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

/** 운영체제 테마가 바뀌면 알려 줍니다('system' 일 때 버튼 아이콘을 맞추는 용도). 해제 함수를 돌려줍니다. */
export function onSystemThemeChange(callback) {
  const query = darkQuery();
  if (!query) return () => {};
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}
