// LoginPage — Charon-style gold/dark login (mockup Charon Login.html, Charon
// branded). 2-step flow: (1) credentials → /auth/login, (2) MFA OTP (backend
// MFA henüz yok; step 2 sadece backend `mfa_required: true` döndürdüğünde aktif
// olur — şimdi placeholder/hazır).
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authApi } from '@/api/auth'
import { useAuthStore } from '@/store/auth'
import { useTranslation } from 'react-i18next'

const CSS = `
:root.charon-login {
  --c-bg-0: #0a0a0e;
  --c-bg-1: #14140f;
  --c-gold: #b8924b;
  --c-gold-soft: #8a6f3d;
  --c-gold-deep: #5a4729;
  --c-ember: #d4a86a;
  --c-fg: #e8dcc4;
  --c-fg-dim: rgba(232,220,196,0.55);
  --c-fg-deep: rgba(232,220,196,0.32);
  --c-line: rgba(184,146,75,0.18);
  --c-crit: #c44a3d;
}
.charon-bg {
  position: fixed; inset: 0;
  background: #050505 url('/login/login-bg.png') center / cover no-repeat;
  filter: brightness(0.95); z-index: 0;
}
.charon-bg::after {
  content: ""; position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 80% 90% at 50% 50%, transparent 30%, rgba(0,0,0,0.55) 100%),
    linear-gradient(180deg, rgba(0,0,0,0.4) 0%, transparent 30%, transparent 70%, rgba(0,0,0,0.65) 100%);
}
.charon-grain {
  position: fixed; inset: 0; pointer-events: none; z-index: 2;
  background-image: repeating-linear-gradient(0deg, transparent 0 2px, rgba(184,146,75,0.008) 2px 3px);
  mix-blend-mode: overlay;
}
.charon-stage {
  position: fixed; inset: 0; z-index: 3;
  display: grid; grid-template-rows: auto 1fr auto auto;
  padding: 36px 56px; pointer-events: none;
}
.charon-stage > * { pointer-events: auto; }

.charon-brand { text-align: center; pointer-events: none; }
.charon-brand-mark { width: 38px; height: 38px; margin: 0 auto 12px; opacity: 0.95; }
.charon-brand-name {
  font-family: 'Cormorant Garamond', serif;
  font-size: 56px; font-weight: 400; letter-spacing: 0.42em;
  color: var(--c-gold);
  text-shadow: 0 0 24px rgba(184,146,75,0.4), 0 0 60px rgba(184,146,75,0.15);
  margin: 0; padding-left: 0.42em; line-height: 1;
}
.charon-brand-tagline {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px; font-weight: 400; letter-spacing: 0.5em;
  color: var(--c-gold-soft); text-transform: uppercase;
  margin: 14px 0 0; padding-left: 0.5em;
}

.charon-ornament {
  position: fixed; z-index: 4; pointer-events: none;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px; letter-spacing: 0.32em;
  color: var(--c-gold-soft); text-transform: uppercase; opacity: 0.65;
}
.charon-ornament .l { font-size: 9px; color: var(--c-fg-deep); margin-bottom: 4px; }
.charon-ornament .frame {
  position: absolute; width: 22px; height: 22px;
  border: 1px solid var(--c-gold-soft); opacity: 0.5;
}
.charon-ornament.tl { top: 40px; left: 56px; }
.charon-ornament.tr { top: 40px; right: 56px; text-align: right; }
.charon-ornament.bl { bottom: 40px; left: 56px; }
.charon-ornament.br { bottom: 40px; right: 56px; text-align: right; }
.charon-ornament.tl .frame { top: -10px; left: -16px; border-right: 0; border-bottom: 0; }
.charon-ornament.tr .frame { top: -10px; right: -16px; border-left: 0; border-bottom: 0; }
.charon-ornament.bl .frame { bottom: -10px; left: -16px; border-right: 0; border-top: 0; }
.charon-ornament.br .frame { bottom: -10px; right: -16px; border-left: 0; border-top: 0; }

.charon-auth-wrap { grid-row: 3; display: grid; place-items: center; padding: 0 0 16px; }
.charon-auth-card {
  width: 100%; max-width: 460px;
  background: linear-gradient(180deg, rgba(20,15,10,0.72) 0%, rgba(10,8,5,0.85) 100%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  backdrop-filter: blur(20px) saturate(140%);
  border: 1px solid rgba(184,146,75,0.22);
  border-radius: 4px;
  padding: 28px 32px 26px;
  position: relative;
  box-shadow: 0 24px 60px rgba(0,0,0,0.6), inset 0 0 32px rgba(184,146,75,0.025);
  animation: charonIn .55s cubic-bezier(0.22,1,0.36,1) both;
}
@keyframes charonIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
.charon-auth-card::before, .charon-auth-card::after,
.charon-auth-card .corner-tr, .charon-auth-card .corner-br {
  content: ""; position: absolute; width: 18px; height: 18px;
  border: 1px solid var(--c-gold); opacity: 0.7;
}
.charon-auth-card::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.charon-auth-card .corner-tr { top: -1px; right: -1px; border-left: 0; border-bottom: 0; }
.charon-auth-card::after { bottom: -1px; left: -1px; border-right: 0; border-top: 0; }
.charon-auth-card .corner-br { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }

.charon-step-bar { display: flex; gap: 4px; margin: -2px 0 18px; }
.charon-step-bar > i {
  flex: 1; height: 1.5px;
  background: rgba(184,146,75,0.15); transition: background .3s;
}
.charon-step-bar > i.active { background: var(--c-gold); box-shadow: 0 0 8px var(--c-gold); }
.charon-step-bar > i.done { background: rgba(184,146,75,0.5); }

.charon-step-label {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9.5px; color: var(--c-gold-soft);
  letter-spacing: 0.32em; text-transform: uppercase; margin-bottom: 6px;
}
.charon-title {
  font-family: 'Cormorant Garamond', serif;
  font-size: 26px; font-weight: 400; letter-spacing: 0.04em;
  color: var(--c-fg); margin: 0 0 4px;
}
.charon-sub { font-size: 12.5px; color: var(--c-fg-dim); line-height: 1.55; margin-bottom: 20px; }

.charon-field { margin-bottom: 12px; }
.charon-field-label {
  display: flex; justify-content: space-between;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9.5px; color: var(--c-fg-dim);
  letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 5px;
}
.charon-field-label a {
  color: var(--c-gold); text-decoration: none;
  text-transform: none; letter-spacing: 0.04em; font-size: 11px;
}
.charon-field-label a:hover { color: var(--c-ember); }
.charon-input-wrap { position: relative; display: flex; align-items: center; }
.charon-input-wrap .ico { position: absolute; left: 12px; color: var(--c-gold-soft); pointer-events: none; }
.charon-input {
  width: 100%; height: 42px;
  background: rgba(8,6,4,0.7);
  border: 1px solid rgba(184,146,75,0.18); border-radius: 3px;
  color: var(--c-fg); font-family: 'IBM Plex Sans', sans-serif;
  font-size: 13.5px; padding: 0 12px 0 38px; outline: none;
  transition: border-color .15s, box-shadow .15s, background .15s;
}
.charon-input::placeholder { color: var(--c-fg-deep); }
.charon-input:focus {
  border-color: var(--c-gold);
  box-shadow: 0 0 0 3px rgba(184,146,75,0.10);
  background: rgba(8,6,4,0.95);
}
.charon-pwd-toggle {
  position: absolute; right: 12px;
  background: none; border: 0; color: var(--c-gold-soft); cursor: pointer; padding: 4px;
}
.charon-pwd-toggle:hover { color: var(--c-ember); }

.charon-cb-row {
  display: flex; align-items: center; gap: 9px;
  margin-bottom: 18px; font-size: 12px; color: var(--c-fg-dim);
}
.charon-cb-row .box {
  width: 14px; height: 14px;
  border: 1px solid rgba(184,146,75,0.35);
  background: rgba(8,6,4,0.5);
  display: grid; place-items: center; cursor: pointer;
  transition: background .15s, border-color .15s;
}
.charon-cb-row .box.on { background: var(--c-gold); border-color: var(--c-gold); }

.charon-btn-primary {
  width: 100%; height: 44px;
  background: linear-gradient(180deg, var(--c-gold) 0%, var(--c-gold-soft) 100%);
  border: 0; border-radius: 3px;
  color: #1a1208;
  font-family: 'IBM Plex Sans', sans-serif;
  font-size: 12.5px; font-weight: 600;
  letter-spacing: 0.22em; text-transform: uppercase;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  transition: filter .12s, transform .12s, box-shadow .2s;
  box-shadow: 0 4px 16px rgba(184,146,75,0.25), inset 0 1px 0 rgba(255,220,160,0.3);
}
.charon-btn-primary:hover:not(:disabled) { filter: brightness(1.08); box-shadow: 0 6px 20px rgba(184,146,75,0.35); }
.charon-btn-primary:active:not(:disabled) { transform: translateY(1px); }
.charon-btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }

.charon-divider {
  display: flex; align-items: center; gap: 12px;
  margin: 18px 0 12px; color: var(--c-fg-deep);
  font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.32em;
}
.charon-divider::before, .charon-divider::after {
  content: ""; flex: 1; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(184,146,75,0.22), transparent);
}
.charon-sso-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
.charon-sso-btn {
  height: 38px;
  background: rgba(8,6,4,0.5);
  border: 1px solid rgba(184,146,75,0.14); border-radius: 3px;
  color: var(--c-fg-dim);
  font-size: 11px; font-family: 'IBM Plex Mono', monospace;
  letter-spacing: 0.08em; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  transition: border-color .15s, color .15s, background .15s;
}
.charon-sso-btn:hover {
  border-color: rgba(184,146,75,0.4); color: var(--c-ember); background: rgba(184,146,75,0.05);
}

.charon-err {
  background: rgba(196,74,61,0.12); border: 1px solid rgba(196,74,61,0.35);
  color: #f1a39b; font-size: 12px;
  padding: 9px 12px; border-radius: 3px; margin-bottom: 14px;
  font-family: 'IBM Plex Mono', monospace; letter-spacing: 0.04em;
}

.charon-footer-line {
  grid-row: 4; text-align: center;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9.5px; letter-spacing: 0.28em; text-transform: uppercase;
  color: var(--c-fg-deep);
  padding-top: 10px;
}
.charon-footer-line .sep { color: var(--c-gold-soft); }

/* MFA Step */
.charon-otp-row {
  display: grid; grid-template-columns: repeat(6, 1fr);
  gap: 8px; margin-bottom: 6px;
}
.charon-otp-input {
  height: 52px;
  background: rgba(8,6,4,0.7);
  border: 1px solid rgba(184,146,75,0.22); border-radius: 3px;
  color: var(--c-fg); font-family: 'IBM Plex Mono', monospace;
  font-size: 22px; font-weight: 500; text-align: center;
  outline: none; transition: border-color .15s, box-shadow .15s;
}
.charon-otp-input:focus {
  border-color: var(--c-gold); box-shadow: 0 0 0 3px rgba(184,146,75,0.12);
}
.charon-mfa-info {
  display: flex; align-items: center; gap: 12px;
  padding: 14px; background: rgba(8,6,4,0.45);
  border: 1px solid rgba(184,146,75,0.18); border-radius: 3px; margin-bottom: 16px;
}
.charon-mfa-info .ico {
  width: 36px; height: 36px;
  background: rgba(184,146,75,0.10);
  border: 1px solid rgba(184,146,75,0.3); border-radius: 3px;
  display: grid; place-items: center; color: var(--c-gold); flex-shrink: 0;
}
.charon-mfa-info .info { flex: 1; min-width: 0; }
.charon-mfa-info .info .name { font-size: 12.5px; font-weight: 500; color: var(--c-fg); }
.charon-mfa-info .info .sub { font-size: 10.5px; color: var(--c-fg-dim); margin-top: 2px; font-family: 'IBM Plex Mono', monospace; }
.charon-back-btn {
  display: inline-flex; align-items: center; gap: 6px;
  background: transparent; border: 0;
  color: var(--c-fg-dim); font-size: 11px; cursor: pointer;
  padding: 0; margin-bottom: 12px;
  font-family: 'IBM Plex Sans', sans-serif; letter-spacing: 0.04em;
}
.charon-back-btn:hover { color: var(--c-gold); }
.charon-resend {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 11.5px; color: var(--c-fg-dim);
  margin-top: 12px; margin-bottom: 18px;
}
.charon-resend .timer { font-family: 'IBM Plex Mono', monospace; color: var(--c-gold); }
`

type Step = 1 | 2 | 3
type MfaMethod = 'app' | 'email' | 'sms'

// Backend henüz MFA döndürmüyor. Future-ready: login response'unda
// `mfa_required: true` + `methods: ['app','email']` + `default_method`
// gelirse step 2'ye geçilir. Şimdi sadece görsel.
interface MfaChallenge {
  required: boolean
  methods?: MfaMethod[]
  defaultMethod?: MfaMethod
  maskedEmail?: string
}

export default function LoginPage() {
  const [step, setStep] = useState<Step>(1)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [remember, setRemember] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [mfa, setMfa] = useState<MfaChallenge>({ required: false })
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('app')
  const [timer, setTimer] = useState(30)
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  const { setAuth } = useAuthStore()
  const navigate = useNavigate()
  const { t } = useTranslation()

  // .charon-login class'ını <html>'a ekleyip kaldır (sadece login sayfasında)
  useEffect(() => {
    document.documentElement.classList.add('charon-login')
    return () => { document.documentElement.classList.remove('charon-login') }
  }, [])

  // OTP timer
  useEffect(() => {
    if (step !== 2) return
    setTimer(30)
    const id = setInterval(() => setTimer((t) => Math.max(0, t - 1)), 1000)
    return () => clearInterval(id)
  }, [step])

  const submitStep1 = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!username.trim() || !password) { setError(t('login.error')); return }
    setLoading(true); setError('')
    try {
      const res = await authApi.login(username, password)
      // Future MFA: response.mfa_required varsa step 2'ye geç.
      const challenge = (res as any).mfa_required
      if (challenge) {
        setMfa({
          required: true,
          methods: (res as any).mfa_methods || ['app'],
          defaultMethod: (res as any).mfa_default_method || 'app',
          maskedEmail: (res as any).masked_email,
        })
        setMfaMethod((res as any).mfa_default_method || 'app')
        setStep(2)
      } else {
        // Direkt giriş
        setAuth(
          res.access_token,
          { id: res.user_id, username: res.username, role: res.role as any,
            system_role: (res.system_role as any) ?? 'member', org_id: res.org_id },
          res.permissions,
        )
        navigate('/')
      }
    } catch {
      setError(t('login.error'))
    } finally { setLoading(false) }
  }

  const submitStep2 = async () => {
    const code = otp.join('')
    if (code.length !== 6) { setError('6 haneli kod girin'); return }
    setLoading(true); setError('')
    try {
      // Future: authApi.verifyMfa(challengeToken, code, method)
      // Şu an backend desteklemiyor — placeholder.
      setError('MFA backend desteği henüz hazır değil — Step 1 tek başına çalışır.')
    } finally { setLoading(false) }
  }

  const onOtpChange = (i: number, v: string) => {
    const digit = v.replace(/\D/g, '').slice(-1)
    const next = [...otp]; next[i] = digit
    setOtp(next)
    if (digit && i < 5) otpRefs.current[i + 1]?.focus()
  }
  const onOtpKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otp[i] && i > 0) otpRefs.current[i - 1]?.focus()
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="charon-bg" />
      <div className="charon-grain" />

      {/* Köşe süslemeleri (dekoratif) */}
      <div className="charon-ornament tl"><span className="frame" /><div className="l">— ⊕ —</div></div>
      <div className="charon-ornament tr"><span className="frame" /><div className="l">— ⊕ —</div></div>
      <div className="charon-ornament bl"><span className="frame" /><div className="l">est · mmxxvi</div></div>
      <div className="charon-ornament br"><span className="frame" /><div className="l">— ⊕ —</div></div>

      <div className="charon-stage">
        {/* Brand */}
        <div className="charon-brand">
          <div className="charon-brand-mark">
            <svg viewBox="0 0 40 40" fill="none">
              <defs>
                <linearGradient id="charonMark" x1="0" y1="0" x2="40" y2="40">
                  <stop offset="0%" stopColor="#d4a86a" />
                  <stop offset="100%" stopColor="#8a6f3d" />
                </linearGradient>
              </defs>
              <polygon points="20,3 37,20 20,37 3,20" fill="none" stroke="url(#charonMark)" strokeWidth="1.5" />
              <polygon points="20,12 28,20 20,28 12,20" fill="none" stroke="url(#charonMark)" strokeWidth="1" />
              <circle cx="20" cy="20" r="1.5" fill="#d4a86a" />
            </svg>
          </div>
          <h1 className="charon-brand-name">CHARON</h1>
          <div className="charon-brand-tagline">Universal Network Intelligence</div>
        </div>

        {/* Auth Card */}
        <div className="charon-auth-wrap">
          <div className="charon-auth-card">
            <span className="corner-tr" /><span className="corner-br" />

            {step === 1 && (
              <form onSubmit={submitStep1}>
                <div className="charon-step-bar"><i className="active" /><i /></div>
                <div className="charon-step-label">— Adım 1 / 2 · Kimlik —</div>
                <h2 className="charon-title">Hoş geldiniz</h2>
                <p className="charon-sub">Geçişe başlamak için kimlik bilgilerinizi sunun.</p>

                {error && <div className="charon-err">{error}</div>}

                <div className="charon-field">
                  <div className="charon-field-label"><span>Kullanıcı</span></div>
                  <div className="charon-input-wrap">
                    <span className="ico">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" />
                      </svg>
                    </span>
                    <input type="text" id="username" className="charon-input" placeholder="kullanici.adi"
                      value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
                  </div>
                </div>

                <div className="charon-field">
                  <div className="charon-field-label">
                    <span>Şifre</span>
                    <a href="#" onClick={(e) => { e.preventDefault() }}>Unuttunuz mu?</a>
                  </div>
                  <div className="charon-input-wrap">
                    <span className="ico">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 018 0v3" />
                      </svg>
                    </span>
                    <input id="password" className="charon-input" type={showPwd ? 'text' : 'password'} placeholder="••••••••"
                      value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                    <button type="button" className="charon-pwd-toggle" onClick={() => setShowPwd((v) => !v)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="charon-cb-row">
                  <span className={`box ${remember ? 'on' : ''}`} onClick={() => setRemember(!remember)}>
                    {remember && <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                      <path d="M3 8.5L6 11.5L13 4.5" stroke="#1a1208" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>}
                  </span>
                  <label onClick={() => setRemember(!remember)} style={{ cursor: 'pointer' }}>Bu cihazda kal</label>
                </div>

                <button type="submit" className="charon-btn-primary" disabled={loading}>
                  {loading ? 'GİRİŞ YAPILIYOR…' : 'DEVAM ET'}
                  {!loading && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>}
                </button>

                <div className="charon-divider">— ya da —</div>
                <div className="charon-sso-row">
                  {[
                    { id: 'azure', label: 'Azure AD' },
                    { id: 'okta',  label: 'Okta' },
                    { id: 'saml',  label: 'SAML' },
                  ].map((s) => (
                    <button key={s.id} type="button" className="charon-sso-btn"
                      onClick={() => setError(`${s.label} SSO henüz konfigüre edilmedi`)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </form>
            )}

            {step === 2 && (
              <div>
                <div className="charon-step-bar"><i className="done" /><i className="active" /></div>
                <button type="button" className="charon-back-btn" onClick={() => { setStep(1); setError('') }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M19 12H5M11 18l-6-6 6-6" />
                  </svg>
                  Geri
                </button>
                <div className="charon-step-label">— Adım 2 / 2 · Doğrulama —</div>
                <h2 className="charon-title">Kimliğinizi doğrulayın</h2>
                <p className="charon-sub">
                  {mfaMethod === 'app' && <>Authenticator uygulamanızdaki <strong style={{ color: 'var(--c-fg)' }}>6 haneli kodu</strong> girin.</>}
                  {mfaMethod === 'email' && <><strong style={{ color: 'var(--c-fg)' }}>{mfa.maskedEmail || 'e-posta'}</strong> adresine gönderilen kodu girin.</>}
                </p>

                {error && <div className="charon-err">{error}</div>}

                <div className="charon-mfa-info">
                  <div className="ico">
                    {mfaMethod === 'app' && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <rect x="5" y="2" width="14" height="20" rx="2" /><path d="M9 7h6M12 18v.01" />
                      </svg>
                    )}
                    {mfaMethod === 'email' && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 8l9 6 9-6" />
                      </svg>
                    )}
                  </div>
                  <div className="info">
                    <div className="name">{mfaMethod === 'app' ? 'Authenticator App' : 'E-posta'}</div>
                    <div className="sub">{mfaMethod === 'app' ? 'Google / Microsoft / Authy / 1Password' : (mfa.maskedEmail || '—')}</div>
                  </div>
                  {(mfa.methods?.length ?? 0) > 1 && (
                    <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 9.5, color: 'var(--c-gold)', letterSpacing: '0.14em', textTransform: 'uppercase', cursor: 'pointer', padding: '4px 8px' }}
                      onClick={() => setMfaMethod(mfaMethod === 'app' ? 'email' : 'app')}>
                      Değiştir
                    </span>
                  )}
                </div>

                <div className="charon-otp-row">
                  {otp.map((d, i) => (
                    <input key={i}
                      ref={(el) => { otpRefs.current[i] = el }}
                      className="charon-otp-input"
                      type="text" inputMode="numeric" maxLength={1}
                      value={d} onChange={(e) => onOtpChange(i, e.target.value)}
                      onKeyDown={(e) => onOtpKey(i, e)} autoFocus={i === 0} />
                  ))}
                </div>

                <div className="charon-resend">
                  <span>{timer > 0 ? 'Kod gelmedi mi?' : <a href="#" onClick={(e) => { e.preventDefault(); setTimer(30) }} style={{ color: 'var(--c-gold)' }}>Tekrar gönder</a>}</span>
                  {timer > 0 && <span className="timer">{`00:${String(timer).padStart(2, '0')}`}</span>}
                </div>

                <button type="button" className="charon-btn-primary" disabled={loading || otp.join('').length !== 6}
                  onClick={submitStep2}>
                  {loading ? 'DOĞRULANIYOR…' : 'DOĞRULA VE GEÇ'}
                  {!loading && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="charon-footer-line">
          Charon <span className="sep">·</span> Universal Network Intelligence <span className="sep">·</span> © 2026
        </div>
      </div>
    </>
  )
}
