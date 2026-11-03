// 새 버전 확인 — Rust(update_check.rs)와 같은 규칙이다. GitHub 저장소의 "최신 릴리스"와 지금 앱 버전을 비교해 알려준다(자동 설치는 하지 않는다).
const REPO = 'gyeongho-you/claude-team-monitor';
const RELEASE_URL_PREFIX = 'https://github.com/gyeongho-you/claude-team-monitor/';

/** "v0.2.1", "0.2" 같은 태그를 숫자 조각으로. 숫자로 시작하지 않으면 null. "-beta" 같은 꼬리표는 떼고 { parts, pre }로 돌려준다. */
function parseVersion(v) {
  const s = String(v || '').trim().replace(/^[vV]/, '');
  const m = s.match(/^([0-9]+(?:\.[0-9]+)*)([-+].*)?$/);
  if (!m) return null;
  return { parts: m[1].split('.').map(Number), pre: !!m[2] };
}

/** latest가 current보다 새 버전이면 true. 해석할 수 없으면 false(알림을 잘못 띄우는 쪽보다 놓치는 쪽이 낫다). */
function isNewer(latest, current) {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  const n = Math.max(l.parts.length, c.parts.length);
  for (let i = 0; i < n; i++) {
    const a = l.parts[i] || 0;
    const b = c.parts[i] || 0;
    if (a !== b) return a > b;
  }
  return c.pre && !l.pre; // 숫자가 같으면 정식이 시험판보다 새 것이다
}

function base(current) {
  return { current, latest: null, updateAvailable: false, url: null, name: null, publishedAt: null, noRelease: false, error: null };
}

/** GitHub "latest release" 응답을 해석한다(순수 함수). */
function interpretResponse(current, httpCode, body) {
  if (httpCode === 404) return { ...base(current), noRelease: true };
  if (httpCode === 403 || httpCode === 429) return { ...base(current), error: 'GitHub가 요청을 잠시 막았습니다(요청이 너무 많음). 잠시 후 다시 확인하세요.' };
  if (httpCode !== 200) return { ...base(current), error: `GitHub 응답이 예상과 다릅니다(HTTP ${httpCode}).` };
  let rel;
  try { rel = JSON.parse(body); } catch { return { ...base(current), error: 'GitHub 응답을 해석하지 못했습니다.' }; }
  const tag = rel && typeof rel.tag_name === 'string' ? rel.tag_name : '';
  if (!tag) return { ...base(current), error: '최신 릴리스의 버전(태그)을 찾지 못했습니다.' };
  return {
    ...base(current),
    latest: tag,
    updateAvailable: isNewer(tag, current),
    // 열 주소는 이 저장소의 릴리스 페이지일 때만 믿는다.
    url: typeof rel.html_url === 'string' && rel.html_url.startsWith(RELEASE_URL_PREFIX) ? rel.html_url : null,
    name: typeof rel.name === 'string' && rel.name ? rel.name : null,
    publishedAt: typeof rel.published_at === 'string' ? rel.published_at : null,
  };
}

function isSafeReleaseUrl(url) {
  return typeof url === 'string' && url.startsWith(RELEASE_URL_PREFIX) && url.length < 300 && /^[A-Za-z0-9/._\-:%#?=~]+$/.test(url);
}

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

module.exports = { parseVersion, isNewer, interpretResponse, isSafeReleaseUrl, LATEST_RELEASE_API };
