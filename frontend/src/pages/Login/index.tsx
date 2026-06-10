// LoginPage — Charon Secure Gateway (yeni tasarım, 2026-06-03).
// Tasarım kaynağı: Netmanager/Charon Login.html — port edildi React/TSX'e.
// Auth akışı korunur: (1) credentials → /auth/login → (2) MFA (TOTP/recovery/email)
// → /auth/mfa/verify. Backend dokunulmadı; SSO butonları placeholder (henüz konfigüre).
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authApi } from '@/api/auth'
import type { TokenResponse } from '@/types'
import { useAuthStore } from '@/store/auth'
import { useHasHydrated } from '@/hooks/useHasHydrated'
import { useTranslation, Trans } from 'react-i18next'

const CSS = `
:root.charon-login {
  --c-bg-0: #050505;
  --c-gold: #c8a35a;
  --c-gold-soft: #8a6f3d;
  --c-gold-deep: #5a4729;
  --c-ember: #e0bd7e;
  --c-fg: #e8dcc4;
  --c-fg-dim: rgba(232, 220, 196, 0.55);
  --c-fg-deep: rgba(232, 220, 196, 0.30);
  --c-line: rgba(184, 146, 75, 0.18);
  --c-crit: #c44a3d;
  --c-ok: #6fae7a;
  --c-font-tac: 'Orbitron', 'IBM Plex Mono', monospace;
  --c-font-mono: 'IBM Plex Mono', monospace;
  --c-font-serif: 'Cormorant Garamond', serif;
}
html.charon-login, html.charon-login body {
  margin: 0; padding: 0; height: 100%;
  background: #030303;
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  color: var(--c-fg);
  overflow: hidden;
}

/* ── Layer 0: datacenter aisle background ── */
.cl-bg {
  position: fixed; inset: 0; z-index: 0;
  background:
    radial-gradient(ellipse 46% 30% at 50% 40%, rgba(110,80,36,0.30) 0%, transparent 64%),
    radial-gradient(ellipse 70% 50% at 50% 106%, rgba(5,4,7,0.94) 0%, transparent 60%),
    linear-gradient(180deg, #070710 0%, #08070c 40%, #0a0809 62%, #050407 100%);
}
.cl-bg::after {
  content: ""; position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 92% 96% at 50% 44%, transparent 58%, rgba(2,2,3,0.45) 100%),
    linear-gradient(180deg, rgba(3,3,4,0.42) 0%, transparent 22%, transparent 52%, rgba(2,2,3,0.72) 100%);
}
.cl-bg-tint {
  position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background: radial-gradient(ellipse 80% 70% at 50% 45%, rgba(140,100,44,0.18), transparent 70%);
  mix-blend-mode: overlay;
}

/* ── Layer 1: live network canvas ── */
.cl-net { position: fixed; inset: 0; z-index: 1; pointer-events: none; }

/* ── Layer 2: HUD scanline + grid ── */
.cl-hud-grid {
  position: fixed; inset: 0; z-index: 2; pointer-events: none;
  background-image:
    linear-gradient(rgba(184,146,75,0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(184,146,75,0.025) 1px, transparent 1px);
  background-size: 64px 64px;
  mask-image: radial-gradient(ellipse 90% 90% at 50% 45%, black 35%, transparent 80%);
  -webkit-mask-image: radial-gradient(ellipse 90% 90% at 50% 45%, black 35%, transparent 80%);
}
.cl-scanbeam {
  position: fixed; left: 0; right: 0; top: 0; height: 140px;
  z-index: 2; pointer-events: none;
  background: linear-gradient(180deg, transparent, rgba(200,163,90,0.05) 60%, rgba(200,163,90,0.12) 100%);
  border-bottom: 1px solid rgba(200,163,90,0.10);
  animation: cl-scan 9s linear infinite;
  opacity: 0.7;
}
@keyframes cl-scan { 0% { transform: translateY(-160px); } 100% { transform: translateY(100vh); } }
.cl-grain {
  position: fixed; inset: 0; z-index: 3; pointer-events: none;
  background-image: repeating-linear-gradient(0deg, transparent 0 2px, rgba(184,146,75,0.006) 2px 3px);
  mix-blend-mode: overlay;
}

/* ── Tactical corner HUD ── */
.cl-hud {
  position: fixed; z-index: 5; pointer-events: none;
  font-family: var(--c-font-mono);
  font-size: 10px; letter-spacing: 0.14em;
  color: var(--c-fg-dim); line-height: 1.7;
}
.cl-hud .k {
  font-family: var(--c-font-tac);
  font-size: 8.5px; font-weight: 600;
  letter-spacing: 0.26em; color: var(--c-gold-soft);
  text-transform: uppercase;
}
.cl-hud .v { color: var(--c-ember); }
.cl-hud .ok { color: var(--c-ok); }
.cl-hud .sep { color: var(--c-gold-deep); margin: 0 6px; }
.cl-hud-row { display: flex; align-items: baseline; gap: 8px; }
.cl-hud.tl { top: 40px; left: 52px; }
.cl-hud.bl { bottom: 40px; left: 52px; }
.cl-hud.tr { top: 40px; right: 52px; text-align: right; }
.cl-hud.br { bottom: 40px; right: 52px; text-align: right; }
.cl-hud.tr .cl-hud-row, .cl-hud.br .cl-hud-row { justify-content: flex-end; }
.cl-hud .bracket {
  position: absolute; width: 26px; height: 26px;
  border: 1px solid var(--c-gold-soft); opacity: 0.5;
}
.cl-hud.tl .bracket { top: -14px; left: -18px; border-right: 0; border-bottom: 0; }
.cl-hud.tr .bracket { top: -14px; right: -18px; border-left: 0; border-bottom: 0; }
.cl-hud.bl .bracket { bottom: -14px; left: -18px; border-right: 0; border-top: 0; }
.cl-hud.br .bracket { bottom: -14px; right: -18px; border-left: 0; border-top: 0; }
.cl-live-dot {
  display: inline-block; width: 5px; height: 5px; border-radius: 50%;
  background: var(--c-ok); box-shadow: 0 0 7px var(--c-ok);
  animation: cl-blink 1.8s ease-in-out infinite; vertical-align: middle;
}
@keyframes cl-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

/* ── Stage — flex layout, brand + card grup olarak dikey ortalı ── */
.cl-stage {
  position: fixed; inset: 0; z-index: 6;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 40px 56px 80px; pointer-events: none;
  gap: 28px;
}
.cl-stage > * { pointer-events: auto; }

/* ── Brand — daha kompakt, card'a yakın ── */
.cl-brand { text-align: center; pointer-events: none; }
.cl-brand-mark { width: 36px; height: 36px; margin: 0 auto 10px; opacity: 0.96; }
.cl-brand-mark svg { width: 100%; height: 100%; }
.cl-brand-name {
  font-family: var(--c-font-serif);
  font-size: 48px; font-weight: 400; letter-spacing: 0.36em;
  color: var(--c-gold);
  text-shadow: 0 0 24px rgba(200,163,90,0.42), 0 0 60px rgba(200,163,90,0.16);
  margin: 0; padding-left: 0.36em; line-height: 1;
}
.cl-brand-tagline {
  font-family: var(--c-font-tac);
  font-size: 9px; font-weight: 500; letter-spacing: 0.44em;
  color: var(--c-gold-soft); text-transform: uppercase;
  margin: 12px 0 0; padding-left: 0.44em;
}
.cl-brand-under {
  font-family: var(--c-font-mono); font-size: 9.5px;
  letter-spacing: 0.28em; color: var(--c-fg-deep);
  margin-top: 8px; text-transform: uppercase;
}
.cl-brand-under .cl-live-dot { margin-right: 7px; }

/* ── Auth zone ── */
.cl-auth-wrap { width: 100%; display: flex; justify-content: center; }
.cl-auth-card {
  width: 100%; max-width: 470px;
  background: linear-gradient(180deg, rgba(16,13,9,0.82) 0%, rgba(7,6,4,0.90) 100%);
  -webkit-backdrop-filter: blur(22px) saturate(135%);
  backdrop-filter: blur(22px) saturate(135%);
  border: 1px solid rgba(184,146,75,0.24);
  border-radius: 5px; position: relative;
  box-shadow: 0 30px 70px rgba(0,0,0,0.65), inset 0 0 36px rgba(184,146,75,0.03);
  overflow: hidden;
}
.cl-auth-card::before {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, var(--c-gold), transparent);
  opacity: 0.6;
}
.cl-corner { position: absolute; width: 16px; height: 16px; border: 1px solid var(--c-gold); opacity: 0.65; z-index: 2; }
.cl-corner.tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.cl-corner.tr { top: -1px; right: -1px; border-left: 0; border-bottom: 0; }
.cl-corner.bl { bottom: -1px; left: -1px; border-right: 0; border-top: 0; }
.cl-corner.br { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }

.cl-card-strip {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 18px; border-bottom: 1px solid rgba(184,146,75,0.16);
  background: rgba(184,146,75,0.04);
  font-family: var(--c-font-mono); font-size: 10px;
  letter-spacing: 0.14em; color: var(--c-fg-dim);
}
.cl-card-strip .seg { display: flex; align-items: center; gap: 6px; }
.cl-card-strip .seg svg { color: var(--c-gold); }
.cl-card-strip .sep { color: var(--c-gold-deep); }
.cl-card-strip .grow { flex: 1; }
.cl-card-strip .handshake { color: var(--c-ok); }
.cl-card-body { padding: 24px 30px 26px; }

.cl-step-bar { display: flex; gap: 4px; margin: 0 0 16px; }
.cl-step-bar > i { flex: 1; height: 2px; background: rgba(184,146,75,0.15); transition: background .3s; border-radius: 2px; }
.cl-step-bar > i.active { background: var(--c-gold); box-shadow: 0 0 8px var(--c-gold); }
.cl-step-bar > i.done { background: rgba(184,146,75,0.5); }

.cl-step-label {
  font-family: var(--c-font-tac); font-size: 8.5px; font-weight: 600;
  color: var(--c-gold-soft); letter-spacing: 0.28em; text-transform: uppercase;
  margin-bottom: 8px;
}
.cl-title {
  font-family: var(--c-font-serif);
  font-size: 28px; font-weight: 400; letter-spacing: 0.03em;
  color: var(--c-fg); margin: 0 0 4px;
}
.cl-sub { font-size: 12.5px; color: var(--c-fg-dim); line-height: 1.55; margin-bottom: 20px; }

.cl-err {
  background: rgba(196,74,61,0.10); border: 1px solid rgba(196,74,61,0.35);
  border-radius: 4px; padding: 8px 12px; margin: 0 0 14px;
  color: #f4c4bf; font-family: var(--c-font-mono); font-size: 11.5px; letter-spacing: 0.04em;
}

.cl-field { margin-bottom: 13px; }
.cl-field-label {
  display: flex; justify-content: space-between;
  font-family: var(--c-font-mono); font-size: 9.5px; color: var(--c-fg-dim);
  letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 6px;
}
.cl-field-label a { color: var(--c-gold); text-decoration: none; text-transform: none; letter-spacing: 0.04em; font-size: 11px; }
.cl-field-label a:hover { color: var(--c-ember); }
.cl-input-wrap { position: relative; display: flex; align-items: center; }
.cl-input-wrap .ico { position: absolute; left: 13px; color: var(--c-gold-soft); pointer-events: none; display: flex; }
.cl-input {
  width: 100%; height: 44px;
  background: rgba(6,5,3,0.7);
  border: 1px solid rgba(184,146,75,0.20);
  border-radius: 4px; color: var(--c-fg);
  font-family: var(--c-font-mono); font-size: 13px;
  padding: 0 12px 0 40px; outline: none;
  transition: border-color .15s, box-shadow .15s, background .15s;
  letter-spacing: 0.02em;
}
.cl-input::placeholder { color: var(--c-fg-deep); font-family: var(--c-font-mono); }
.cl-input:focus {
  border-color: var(--c-gold);
  box-shadow: 0 0 0 3px rgba(184,146,75,0.10);
  background: rgba(6,5,3,0.96);
}
.cl-pwd-toggle { position: absolute; right: 12px; background: none; border: 0; color: var(--c-gold-soft); cursor: pointer; padding: 4px; display: flex; }
.cl-pwd-toggle:hover { color: var(--c-ember); }

.cl-cb-row { display: flex; align-items: center; gap: 9px; margin-bottom: 18px; font-size: 12px; color: var(--c-fg-dim); }
.cl-cb-row .box {
  width: 15px; height: 15px; border: 1px solid rgba(184,146,75,0.38);
  background: rgba(6,5,3,0.5); border-radius: 3px;
  display: grid; place-items: center; cursor: pointer; transition: background .15s, border-color .15s;
}
.cl-cb-row .box.on { background: var(--c-gold); border-color: var(--c-gold); }
.cl-cb-row label { cursor: pointer; user-select: none; }

.cl-btn-primary {
  width: 100%; max-width: 100%; box-sizing: border-box; height: 46px;
  background: linear-gradient(180deg, var(--c-ember) 0%, var(--c-gold-soft) 100%);
  border: 0; border-radius: 4px; color: #160f06;
  font-family: var(--c-font-tac); font-size: 11px; font-weight: 600;
  letter-spacing: 0.22em; text-transform: uppercase; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  transition: filter .12s, transform .12s, box-shadow .2s; position: relative; overflow: hidden;
  box-shadow: 0 4px 18px rgba(184,146,75,0.28), inset 0 1px 0 rgba(255,228,170,0.35);
}
.cl-btn-primary:not(:disabled):hover { filter: brightness(1.08); box-shadow: 0 6px 22px rgba(184,146,75,0.4); }
.cl-btn-primary:not(:disabled):active { transform: translateY(1px); }
.cl-btn-primary:disabled { filter: grayscale(0.4) brightness(0.85); cursor: not-allowed; }
.cl-btn-primary .sheen {
  position: absolute; top: 0; bottom: 0; width: 40%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
  transform: skewX(-20deg); left: -50%;
  animation: cl-sheen 3.5s ease-in-out infinite;
  pointer-events: none;
}
@keyframes cl-sheen { 0% { left: -60%; } 55%,100% { left: 160%; } }

.cl-divider {
  display: flex; align-items: center; gap: 12px; margin: 18px 0 12px;
  color: var(--c-fg-deep); font-family: var(--c-font-mono);
  font-size: 9px; letter-spacing: 0.3em; text-transform: uppercase;
}
.cl-divider::before, .cl-divider::after {
  content: ""; flex: 1; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(184,146,75,0.22), transparent);
}

.cl-sso-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 7px; }
.cl-sso-btn {
  height: 40px; background: rgba(6,5,3,0.5);
  border: 1px solid rgba(184,146,75,0.16); border-radius: 4px;
  color: var(--c-fg-dim); font-size: 11px; font-family: var(--c-font-mono);
  letter-spacing: 0.06em; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  transition: border-color .15s, color .15s, background .15s;
}
.cl-sso-btn:hover { border-color: rgba(184,146,75,0.42); color: var(--c-ember); background: rgba(184,146,75,0.05); }
.cl-sso-btn svg { flex-shrink: 0; }

/* OTP */
/* MFA-LOGIN-UI-HOTFIX (2026-06-08) — repeat(6,1fr) track'inde input
   min-width: auto → min-content; box-sizing yok → 6 input + 5 gap kart
   içerik bütçesini (~410px) aşıp .cl-auth-card overflow: hidden ile
   sağ tarafta kırpılıyordu. minmax(0,1fr) + input min-width: 0 ile
   grid track'leri 0'a kadar shrink edebilir. */
.cl-otp-row {
  display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px; margin-bottom: 6px;
  width: 100%; max-width: 100%; min-width: 0;
}
.cl-otp-input {
  width: 100%; min-width: 0; box-sizing: border-box;
  height: 54px; background: rgba(6,5,3,0.7);
  border: 1px solid rgba(184,146,75,0.22); border-radius: 4px;
  color: var(--c-fg); font-family: var(--c-font-mono); font-size: 22px; font-weight: 500;
  text-align: center; outline: none; transition: border-color .15s, box-shadow .15s;
}
.cl-otp-input:focus { border-color: var(--c-gold); box-shadow: 0 0 0 3px rgba(184,146,75,0.12); }
.cl-otp-input.filled { border-color: rgba(184,146,75,0.55); }
.cl-resend-row { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--c-fg-dim); margin-top: 12px; margin-bottom: 18px; }
.cl-resend-row .timer { font-family: var(--c-font-mono); color: var(--c-gold); }
.cl-resend-row .timer.clickable { cursor: pointer; }

.cl-back-btn {
  display: inline-flex; align-items: center; gap: 6px;
  background: transparent; border: 0; color: var(--c-fg-dim);
  font-size: 11px; cursor: pointer; padding: 0; margin-bottom: 12px;
  letter-spacing: 0.04em;
}
.cl-back-btn:hover { color: var(--c-gold); }

/* MFA yöntem segmented control — backend'in mfa.methods listesine göre dinamik */
.cl-mfa-seg {
  display: flex; gap: 0; margin-bottom: 16px;
  background: rgba(6,5,3,0.5);
  border: 1px solid rgba(184,146,75,0.20);
  border-radius: 4px; padding: 3px;
  /* MFA-LOGIN-UI-HOTFIX: defansif shrink (3 buton flex:1 → genişlik üst limit) */
  width: 100%; min-width: 0; box-sizing: border-box;
}
.cl-mfa-seg button {
  flex: 1 1 0; min-width: 0;
  background: transparent; border: 0;
  color: var(--c-fg-dim); font-family: var(--c-font-mono);
  font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase;
  padding: 9px 6px; cursor: pointer; border-radius: 3px;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  transition: background .15s, color .15s;
}
.cl-mfa-seg button:hover:not(.active) { color: var(--c-ember); }
.cl-mfa-seg button.active {
  background: rgba(184,146,75,0.14);
  color: var(--c-gold);
  box-shadow: inset 0 0 0 1px rgba(184,146,75,0.32);
}
.cl-mfa-seg button svg { flex-shrink: 0; opacity: 0.9; }

/* Seçilen yöntem için kısa bilgi satırı (masked email vb.) */
.cl-mfa-hint {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; margin-bottom: 14px;
  background: rgba(6,5,3,0.4);
  border: 1px solid rgba(184,146,75,0.14);
  border-radius: 4px;
  font-family: var(--c-font-mono); font-size: 11px;
  color: var(--c-fg-dim); letter-spacing: 0.02em;
}
.cl-mfa-hint .ico { color: var(--c-gold); display: flex; flex-shrink: 0; }
.cl-mfa-hint strong { color: var(--c-fg); font-weight: 500; }

.cl-success-icon {
  width: 72px; height: 72px; margin: 0 auto 16px; border-radius: 50%;
  background: rgba(184,146,75,0.10); border: 1.5px solid var(--c-gold);
  display: grid; place-items: center; color: var(--c-gold); position: relative;
}
.cl-success-icon::after {
  content: ""; position: absolute; inset: -4px;
  border: 1px solid rgba(184,146,75,0.3); border-radius: 50%;
  animation: cl-pulse 2.4s ease-out infinite;
}
@keyframes cl-pulse { 0% { transform: scale(0.95); opacity: 1; } 100% { transform: scale(1.4); opacity: 0; } }

.cl-footer-line {
  position: fixed; bottom: 16px; left: 0; right: 0;
  text-align: center; font-family: var(--c-font-mono);
  font-size: 9px; color: var(--c-fg-deep);
  letter-spacing: 0.36em; text-transform: uppercase; pointer-events: none;
  z-index: 6;
}
.cl-footer-line .sep { color: var(--c-gold-soft); margin: 0 12px; }

/* MFA-LOGIN-UI-HOTFIX: MFA step (step === 2) wrapper'a flex-column
   sırasıyla render güvenliği + min-width: 0 ile child overflow
   absorbe. Box-sizing: border-box defansif. */
.cl-mfa-step {
  display: flex; flex-direction: column;
  width: 100%; min-width: 0; box-sizing: border-box;
}
@media (max-width: 720px) {
  .cl-stage { padding: 26px 18px; }
  .cl-hud { display: none; }
  .cl-brand-name { font-size: 40px; letter-spacing: 0.30em; }
  .cl-brand-tagline { font-size: 8.5px; letter-spacing: 0.3em; }
  .cl-card-body { padding: 20px; }
}
/* MFA-LOGIN-UI-HOTFIX: 320-380px (oldest iPhone) için ek kompakt mod —
   OTP input 54→48 (h) + font 22→18, card padding daralt; OTP grid 6
   input + 5×8 gap ~282-320 viewport içine sığar. */
@media (max-width: 380px) {
  .cl-stage { padding: 20px 12px 40px; }
  .cl-card-body { padding: 18px 14px; }
  .cl-otp-input { height: 48px; font-size: 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .cl-scanbeam, .cl-btn-primary .sheen { animation: none; }
}
`

const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500;600&family=Orbitron:wght@400;500;600;700&display=swap'

type Step = 1 | 2 | 3
type MfaMethod = 'totp' | 'recovery' | 'email' | 'sms'

interface MfaChallenge {
  required: boolean
  challengeToken?: string
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
  const [recoveryCode, setRecoveryCode] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const [useEmail, setUseEmail] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [emailError, setEmailError] = useState('')
  const [timer, setTimer] = useState(30)
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  // Telemetry / HUD
  const [clock, setClock] = useState('--:--:--')
  const [rtt, setRtt] = useState('— ms')
  const [session] = useState(() => {
    const hex = '0123456789ABCDEF'
    let s = '0x'
    for (let i = 0; i < 6; i++) s += hex[Math.floor(Math.random() * 16)]
    return s
  })

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()
  const { t } = useTranslation()

  // AUTH-LOGIN-REDIRECT-HOTFIX (PR #45) + AUTH-PERSIST-HYDRATION-HOTFIX
  // (PR #47) + LOGIN-AUTH-LOOP-FIX (2026-06-10) — authenticated kullanıcı
  // /login ekranına düşerse Dashboard'a otomatik dön. Önceki '/' route
  // RootRedirect aracısı oluşturmuyordu; doğrudan Dashboard render ediyordu.
  // Bu yeni iterasyonda hedef explicit `/dashboard` — `/` üzerinden geçmek
  // page-reload döngüsünü tetikleyebiliyordu (bkz. nginx access log: 1 sn'de
  // 6 GET /). `hydrated` Zustand persist'in kendi internal flag'inden okunur
  // (useHasHydrated), token store state alanı ayrı subscribe — race yok.
  const hydrated = useHasHydrated()
  const existingToken = useAuthStore((s) => s.token)
  useEffect(() => {
    if (hydrated && existingToken) {
      navigate('/dashboard', { replace: true })
    }
  }, [hydrated, existingToken, navigate])

  // Fontları yükle + .charon-login class
  useEffect(() => {
    document.documentElement.classList.add('charon-login')
    // Google Fonts <link>
    const linkEl = document.createElement('link')
    linkEl.rel = 'stylesheet'
    linkEl.href = FONTS_HREF
    document.head.appendChild(linkEl)
    return () => {
      document.documentElement.classList.remove('charon-login')
      document.head.removeChild(linkEl)
    }
  }, [])

  // Live clock + RTT telemetry (HUD süsleme)
  useEffect(() => {
    const pad = (n: number) => String(n).padStart(2, '0')
    const tick = () => {
      const d = new Date()
      setClock(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`)
    }
    tick()
    const clockId = window.setInterval(tick, 1000)
    const rttTick = () => setRtt(`${8 + Math.floor(Math.random() * 9)} ms`)
    rttTick()
    const rttId = window.setInterval(rttTick, 2200)
    return () => { window.clearInterval(clockId); window.clearInterval(rttId) }
  }, [])

  // OTP timer
  useEffect(() => {
    if (step !== 2) return
    setTimer(30)
    const id = window.setInterval(() => setTimer((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(id)
  }, [step])

  // Canvas scene — datacenter aisle + network packets (HTML port)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let DPR = 1, w = 0, h = 0, riverY = 0
    let skyline: any[] = []
    let rackLinks: { a: number; b: number; up: boolean }[] = []
    let packets: any[] = []
    let fog: any[] = []
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 }
    let raf = 0
    let stopped = false

    const labelPool: Record<string, string[]> = {
      '-1': ['CORE-SW-01', 'DIST-SW-01', 'SRV-CL-A', 'FW-01', 'ACC-SW-07'],
      '1':  ['CORE-SW-02', 'DIST-SW-02', 'SRV-CL-B', 'LB-01', 'ACC-SW-11'],
    }
    const typeBy = (lbl: string) =>
      lbl.startsWith('CORE') ? 'core'
      : lbl.startsWith('DIST') || lbl.startsWith('ACC') ? 'switch'
      : lbl.startsWith('SRV') ? 'server'
      : lbl.startsWith('FW') ? 'fw' : 'lb'

    function build() {
      riverY = h * 0.42
      skyline = []
      const rows = w < 720 ? 7 : 11
      const vanX = w * 0.5, vanY = riverY
      const easeIn = (tt: number) => tt * tt
      for (const side of [-1, 1] as const) {
        for (let i = 0; i < rows; i++) {
          const tt = i / rows
          const e = easeIn(tt)
          const edgeX = side < 0 ? (0.055 * w) : (0.945 * w)
          const cx = edgeX + (vanX - edgeX) * (0.04 + 0.86 * e)
          const cy = (h * 0.74) + (vanY - h * 0.74) * (0.02 + 0.94 * e)
          const rh = (h * 0.54) * (1 - 0.90 * tt)
          const rw = (w * 0.06) * (1 - 0.82 * tt)
          const ledRows = Math.max(3, Math.round(rh / 7.5))
          const leds: any[] = []
          for (let r = 0; r < ledRows; r++) {
            leds.push({
              yf: (r + 0.5) / ledRows,
              on: Math.random() < 0.8,
              green: Math.random() < 0.3,
              blink: 0.4 + Math.random() * 2.2,
              ph: Math.random() * 6.28,
              w2: Math.random() < 0.45,
            })
          }
          skyline.push({
            side, cx, cy, rw: Math.max(2, rw), rh: Math.max(6, rh),
            depth: tt, seed: Math.random() * 999, leds,
            portYf: 0.04 + Math.random() * 0.42,
          })
        }
      }
      skyline.sort((a, b) => b.depth - a.depth)

      const counters: Record<string, number> = { '-1': 0, '1': 0 }
      ;[...skyline].sort((a, b) => a.depth - b.depth).forEach((rk: any) => {
        const key = rk.side < 0 ? '-1' : '1'
        if (rk.depth < 0.5 && counters[key] < labelPool[key].length) {
          rk.label = labelPool[key][counters[key]++]
          rk.dtype = typeBy(rk.label)
          rk.core = rk.dtype === 'core'
        }
      })

      rackLinks = []
      for (let i = 0; i < skyline.length; i++) {
        const ri = skyline[i]
        const rpx = ri.cx
        const rpy = (ri.cy - ri.rh) + ri.rh * ri.portYf
        const cand: { j: number; d: number }[] = []
        for (let j = 0; j < skyline.length; j++) {
          if (j === i) continue
          const rj = skyline[j]
          const jx = rj.cx
          const jy = (rj.cy - rj.rh) + rj.rh * rj.portYf
          cand.push({ j, d: Math.hypot(rpx - jx, rpy - jy) })
        }
        cand.sort((a, b) => a.d - b.d)
        const k = 1 + (Math.random() < 0.55 ? 1 : 0)
        for (let n = 0; n < k && n < cand.length; n++) {
          const j = cand[n].j
          if (cand[n].d > w * 0.34) continue
          if (!rackLinks.some(l => (l.a === j && l.b === i) || (l.a === i && l.b === j))) {
            rackLinks.push({ a: i, b: j, up: false })
          }
        }
      }
      skyline.forEach((rk: any, i: number) => {
        if (rk.label && (rk.dtype === 'core' || rk.dtype === 'dist')) {
          rackLinks.push({ a: i, b: -1, up: true })
        }
      })

      packets = []
      const P = w < 720 ? 16 : 32
      for (let i = 0; i < P; i++) spawnPacket()

      fog = []
      const F = w < 720 ? 6 : 12
      for (let i = 0; i < F; i++) {
        fog.push({
          x: Math.random() * w,
          y: riverY - 30 + Math.random() * 150,
          r: 40 + Math.random() * 90,
          sp: 2 + Math.random() * 5,
          ph: Math.random() * 6.28,
        })
      }
    }

    function spawnPacket() {
      if (!rackLinks.length) return
      const li = Math.floor(Math.random() * rackLinks.length)
      packets.push({
        li, t: Math.random(),
        dir: rackLinks[li].up ? 1 : (Math.random() < 0.5 ? 1 : -1),
        sp: 0.16 + Math.random() * 0.20,
        size: 1.0 + Math.random() * 1.2,
        ember: Math.random() < 0.3,
      })
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth || document.documentElement.clientWidth || 0
      h = window.innerHeight || document.documentElement.clientHeight || 0
      if (w < 2 || h < 2) { window.setTimeout(resize, 60); return }
      canvas!.width = w * DPR
      canvas!.height = h * DPR
      canvas!.style.width = w + 'px'
      canvas!.style.height = h + 'px'
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0)
      build()
    }

    function linkEnds(l: { a: number; b: number; up: boolean }) {
      const a = skyline[l.a]
      const A = { x: a._portx, y: a._porty }
      const vp = { x: w * 0.5, y: riverY }
      const B = l.up ? vp : { x: skyline[l.b]._portx, y: skyline[l.b]._porty }
      return [A, B] as const
    }

    let t0 = performance.now()
    function frame(now: number) {
      if (stopped) return
      const dt = Math.min(now - t0, 50); t0 = now
      ctx!.clearRect(0, 0, w, h)
      mouse.x += (mouse.tx - mouse.x) * 0.04
      mouse.y += (mouse.ty - mouse.y) * 0.04
      const par = reduce ? 0 : 1
      const time = now * 0.001
      const px = mouse.x * 10 * par

      // Datacenter racks + LEDs
      for (const rk of skyline) {
        const fade = 1 - rk.depth * 0.45
        const cx = rk.cx + px * (0.2 + rk.depth * 0.5) * rk.side
        const x0 = cx - rk.rw / 2, y0 = rk.cy - rk.rh, ww = rk.rw, hh = rk.rh
        rk._portx = cx; rk._porty = y0 + hh * rk.portYf
        const body = ctx!.createLinearGradient(x0, 0, x0 + ww, 0)
        const aisle = rk.side < 0 ? 1 : 0
        body.addColorStop(0, `rgba(${aisle ? 30 : 18},${aisle ? 30 : 18},${aisle ? 40 : 26},${0.96 * fade})`)
        body.addColorStop(0.5, `rgba(34,34,46,${0.97 * fade})`)
        body.addColorStop(1, `rgba(${aisle ? 18 : 30},${aisle ? 18 : 30},${aisle ? 26 : 40},${0.96 * fade})`)
        ctx!.fillStyle = body
        ctx!.fillRect(x0, y0, ww, hh)
        ctx!.fillStyle = `rgba(224,189,126,${0.55 * fade})`
        ctx!.fillRect(rk.side < 0 ? x0 + ww - 1.5 : x0, y0, 1.5, hh)
        ctx!.fillStyle = `rgba(230,194,130,${0.4 * fade})`
        ctx!.fillRect(x0, y0, ww, 1.5)
        const ledX = x0 + ww * 0.16, ledW = ww * 0.68
        for (const L of rk.leds) {
          if (!L.on) continue
          const blinkV = 0.5 + 0.5 * Math.sin(time * L.blink + L.ph)
          const a = (0.4 + 0.55 * blinkV) * fade * 0.92
          const ly = y0 + hh * L.yf
          const col = L.green ? '110,205,140' : '235,200,135'
          const lh = Math.max(1.4, hh * 0.022)
          ctx!.fillStyle = `rgba(${col},${a})`
          const lw = Math.max(1.2, ledW * (L.w2 ? 0.32 : 0.52))
          ctx!.fillRect(ledX, ly, lw, lh)
          ctx!.fillStyle = `rgba(${col},${a * 0.25})`
          ctx!.fillRect(ledX - 1, ly - 1, lw + 2, lh + 2)
          if (L.w2) {
            const col2 = L.green ? '235,200,135' : '110,205,140'
            ctx!.fillStyle = `rgba(${col2},${a * 0.9})`
            ctx!.fillRect(ledX + ledW * 0.52, ly, lw, lh)
          }
        }
      }

      // Floor glow
      const fl = ctx!.createLinearGradient(0, riverY, 0, h)
      fl.addColorStop(0, 'rgba(200,163,90,0.05)')
      fl.addColorStop(0.5, 'rgba(140,100,44,0.03)')
      fl.addColorStop(1, 'rgba(0,0,0,0)')
      ctx!.fillStyle = fl
      ctx!.fillRect(0, riverY, w, h - riverY)

      // Horizon glow
      const hz = ctx!.createRadialGradient(w * 0.5, riverY, 0, w * 0.5, riverY, w * 0.22)
      hz.addColorStop(0, 'rgba(230,194,130,0.16)')
      hz.addColorStop(1, 'rgba(230,194,130,0)')
      ctx!.fillStyle = hz
      ctx!.fillRect(0, riverY - w * 0.18, w, w * 0.36)

      // Fog motes
      for (const m of fog) {
        m.x += m.sp * dt * 0.012
        if (m.x - m.r > w) m.x = -m.r
        const a = 0.016 + 0.010 * Math.sin(time * 0.3 + m.ph)
        const g = ctx!.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r)
        g.addColorStop(0, `rgba(200,163,90,${a})`)
        g.addColorStop(1, 'rgba(200,163,90,0)')
        ctx!.fillStyle = g
        ctx!.beginPath(); ctx!.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx!.fill()
      }

      // Network links
      ctx!.lineWidth = 1.2
      for (const l of rackLinks) {
        const a = skyline[l.a]
        if (a._portx == null) continue
        const [A, B] = linkEnds(l)
        const pulse = 0.5 + 0.5 * Math.sin(time * 1.4 + l.a)
        const base = l.up ? 0.28 : 0.20
        const al = (base + 0.18 * pulse) * (1 - a.depth * 0.4)
        const grad = ctx!.createLinearGradient(A.x, A.y, B.x, B.y)
        grad.addColorStop(0, `rgba(224,189,126,${al})`)
        grad.addColorStop(1, `rgba(200,163,90,${al * 0.5})`)
        ctx!.strokeStyle = grad
        ctx!.beginPath(); ctx!.moveTo(A.x, A.y); ctx!.lineTo(B.x, B.y); ctx!.stroke()
      }

      // Packets
      if (!reduce) {
        for (let pi = packets.length - 1; pi >= 0; pi--) {
          const p = packets[pi]
          p.t += p.sp * p.dir * dt * 0.001
          if (p.t > 1 || p.t < 0) { packets.splice(pi, 1); spawnPacket(); continue }
          const l = rackLinks[p.li]
          if (!l || skyline[l.a]._portx == null) continue
          const [A, B] = linkEnds(l)
          const x = A.x + (B.x - A.x) * p.t
          const y = A.y + (B.y - A.y) * p.t
          const col = p.ember ? '235,200,135' : '200,163,90'
          const g = ctx!.createRadialGradient(x, y, 0, x, y, p.size * 4.5)
          g.addColorStop(0, `rgba(${col},0.95)`)
          g.addColorStop(1, `rgba(${col},0)`)
          ctx!.fillStyle = g
          ctx!.beginPath(); ctx!.arc(x, y, p.size * 4.5, 0, Math.PI * 2); ctx!.fill()
          ctx!.fillStyle = `rgba(${col},1)`
          ctx!.beginPath(); ctx!.arc(x, y, p.size, 0, Math.PI * 2); ctx!.fill()
        }
      }

      // Port nodes + labels
      ctx!.textBaseline = 'middle'
      for (const rk of skyline) {
        if (rk._portx == null) continue
        const pulse = 0.55 + 0.45 * Math.sin(time * 1.8 + rk.seed)
        if (rk.label || rk.depth < 0.35) {
          const nr = rk.label ? (rk.core ? 3.4 : 2.6) : 1.8
          const g = ctx!.createRadialGradient(rk._portx, rk._porty, 0, rk._portx, rk._porty, nr * 5)
          g.addColorStop(0, `rgba(235,200,135,${0.45 * pulse})`)
          g.addColorStop(1, 'rgba(235,200,135,0)')
          ctx!.fillStyle = g
          ctx!.beginPath(); ctx!.arc(rk._portx, rk._porty, nr * 5, 0, Math.PI * 2); ctx!.fill()
          ctx!.fillStyle = `rgba(245,228,196,0.95)`
          ctx!.beginPath(); ctx!.arc(rk._portx, rk._porty, nr, 0, Math.PI * 2); ctx!.fill()
          if (rk.core) {
            ctx!.strokeStyle = `rgba(235,200,135,${0.5 * pulse})`
            ctx!.lineWidth = 1
            ctx!.beginPath(); ctx!.arc(rk._portx, rk._porty, nr * 2.4, 0, Math.PI * 2); ctx!.stroke()
          }
        }
        if (rk.label) {
          const lx = rk._portx, ly = rk._porty - 14
          const icon = rk.dtype === 'core' || rk.dtype === 'switch' ? '⇄'
            : rk.dtype === 'server' ? '▤' : rk.dtype === 'fw' ? '⛨' : '◇'
          ctx!.font = '600 9px Orbitron, monospace'
          ctx!.textAlign = 'center'
          const txt = icon + ' ' + rk.label
          const tw = ctx!.measureText(txt).width + 10
          ctx!.strokeStyle = 'rgba(200,163,90,0.4)'
          ctx!.lineWidth = 1
          ctx!.beginPath(); ctx!.moveTo(rk._portx, rk._porty); ctx!.lineTo(lx, ly + 6); ctx!.stroke()
          ctx!.fillStyle = 'rgba(10,9,7,0.75)'
          ctx!.fillRect(lx - tw / 2, ly - 7, tw, 14)
          ctx!.fillStyle = 'rgba(200,163,90,0.5)'
          ctx!.fillRect(lx - tw / 2, ly - 7, tw, 1)
          ctx!.fillStyle = rk.core ? 'rgba(245,228,196,0.95)' : 'rgba(220,196,150,0.9)'
          ctx!.fillText(txt, lx, ly)
        }
      }
      ctx!.textAlign = 'left'

      raf = requestAnimationFrame(frame)
    }

    const onMouse = (ev: MouseEvent) => {
      mouse.tx = (ev.clientX / window.innerWidth - 0.5)
      mouse.ty = (ev.clientY / window.innerHeight - 0.5)
    }
    resize()
    raf = requestAnimationFrame(frame)
    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMouse)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouse)
    }
  }, [])

  const finalizeSession = (res: TokenResponse) => {
    setAuth(
      res.access_token,
      { id: res.user_id, username: res.username, role: res.role as any,
        system_role: (res.system_role as any) ?? 'member', org_id: res.org_id },
      res.permissions,
    )
    setStep(3)
    // Kısa "Geçiş onaylandı" gösterimi sonrası yönlendir.
    // LOGIN-AUTH-LOOP-FIX (2026-06-10) — '/' yerine '/dashboard'.
    // `/` artık RootRedirect; setAuth sonrası mevcut `existingToken`
    // useEffect'i tetiklerse de o da '/dashboard'a gider — çift gönderim
    // riski yok (her ikisi aynı route, ikincisi no-op).
    window.setTimeout(() => navigate('/dashboard', { replace: true }), 800)
  }

  const submitStep1 = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!username.trim() || !password) { setError(t('login.error')); return }
    setLoading(true); setError('')
    try {
      const res = await authApi.login(username, password)
      if ('mfa_required' in res && res.mfa_required) {
        const methods = (res.mfa_methods?.length ? res.mfa_methods : ['totp']) as MfaMethod[]
        const def = (res.mfa_default_method || methods[0] || 'totp') as MfaMethod
        setMfa({
          required: true,
          challengeToken: res.challenge_token,
          methods,
          defaultMethod: def,
          maskedEmail: res.masked_email ?? undefined,
        })
        setOtp(['', '', '', '', '', ''])
        setRecoveryCode('')
        setUseRecovery(false)
        setUseEmail(false)
        setEmailSent(false)
        setEmailError('')
        setStep(2)
      } else if ('access_token' in res) {
        finalizeSession(res)
      } else {
        setError(t('login.error'))
      }
    } catch {
      setError(t('login.error'))
    } finally { setLoading(false) }
  }

  const sendEmailCode = async () => {
    if (!mfa.challengeToken) {
      setError(t('login.err.no_challenge')); return
    }
    setLoading(true); setEmailError('')
    try {
      const res = await authApi.sendMfaEmailCode(mfa.challengeToken)
      setEmailSent(true)
      setMfa((m) => ({ ...m, maskedEmail: res.email_masked || m.maskedEmail }))
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      setEmailError(detail || t('login.err.email_send_failed'))
    } finally { setLoading(false) }
  }

  const submitStep2 = async () => {
    if (!mfa.challengeToken) { setError(t('login.err.no_challenge')); return }
    const code = useRecovery ? recoveryCode.trim() : otp.join('')
    const method: 'totp' | 'recovery' | 'email' =
      useEmail ? 'email' : (useRecovery ? 'recovery' : 'totp')
    if (!useRecovery && code.length !== 6) { setError(t('login.err.invalid_code')); return }
    if (useRecovery && code.replace(/[-\s]/g, '').length < 8) { setError(t('login.err.invalid_code')); return }
    setLoading(true); setError('')
    try {
      const res = await authApi.verifyMfa(mfa.challengeToken, code, method)
      finalizeSession(res)
    } catch (err: any) {
      const status = err?.response?.status
      const detail = err?.response?.data?.detail
      if (status === 401 && detail?.toLowerCase?.().includes('challenge')) {
        setError(t('login.err.expired'))
        setStep(1)
        setMfa({ required: false })
      } else {
        setError(detail || t('login.err.invalid_code'))
        if (!useRecovery) setOtp(['', '', '', '', '', ''])
      }
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

  const methodLabel = useEmail
    ? t('login.method.email_label')
    : useRecovery
      ? t('login.method.recovery_label')
      : t('login.method.totp_label')
  const methodSub = useEmail
    ? (mfa.maskedEmail || t('login.method.email_sub_default'))
    : useRecovery
      ? t('login.method.recovery_sub')
      : t('login.method.totp_sub')

  return (
    <>
      <style>{CSS}</style>
      <div className="cl-bg" />
      <div className="cl-bg-tint" />
      <canvas ref={canvasRef} className="cl-net" />
      <div className="cl-hud-grid" />
      <div className="cl-scanbeam" />
      <div className="cl-grain" />

      {/* HUD corners */}
      <div className="cl-hud tl">
        <span className="bracket" />
        <div className="k">Styx Gateway</div>
        <div className="cl-hud-row"><span className="v">gw-styx-01.charon.net</span></div>
        <div className="cl-hud-row" style={{ marginTop: 8 }}>
          <span className="k">Region</span><span className="v">eu-central · iad</span>
        </div>
      </div>
      <div className="cl-hud tr">
        <span className="bracket" />
        <div className="k">Secure Channel</div>
        <div className="cl-hud-row"><span className="ok">TLS 1.3</span><span className="sep">·</span><span className="v">AES-256-GCM</span></div>
        <div className="cl-hud-row" style={{ marginTop: 8 }}>
          <span className="k">Cipher</span><span className="v">X25519-Kyber768</span>
        </div>
      </div>
      <div className="cl-hud bl">
        <span className="bracket" />
        <div className="k">Channel Status</div>
        <div className="cl-hud-row"><span className="cl-live-dot" /><span className="ok">ENCRYPTED · READY</span></div>
        <div className="cl-hud-row" style={{ marginTop: 8 }}>
          <span className="k">RTT</span><span className="v">{rtt}</span>
        </div>
      </div>
      <div className="cl-hud br">
        <span className="bracket" />
        <div className="k">Build</div>
        <div className="cl-hud-row"><span className="v">v4.2.0 · gold</span></div>
        <div className="cl-hud-row" style={{ marginTop: 8 }}>
          <span className="k">Session</span><span className="v">{session}</span>
        </div>
      </div>

      <div className="cl-stage">
        {/* Brand */}
        <div className="cl-brand">
          <div className="cl-brand-mark">
            <svg viewBox="0 0 40 40" fill="none">
              <defs>
                <linearGradient id="cl-markGrad" x1="0" y1="0" x2="40" y2="40">
                  <stop offset="0%" stopColor="#e0bd7e" />
                  <stop offset="100%" stopColor="#8a6f3d" />
                </linearGradient>
              </defs>
              <polygon points="20,3 37,20 20,37 3,20" fill="none" stroke="url(#cl-markGrad)" strokeWidth="1.5" />
              <polygon points="20,12 28,20 20,28 12,20" fill="none" stroke="url(#cl-markGrad)" strokeWidth="1" />
              <circle cx="20" cy="20" r="1.6" fill="#e0bd7e" />
            </svg>
          </div>
          <h1 className="cl-brand-name">CHARON</h1>
          <div className="cl-brand-tagline">Networks Between Worlds</div>
          <div className="cl-brand-under"><span className="cl-live-dot" />Enterprise Network Intelligence</div>
        </div>

        {/* Auth card */}
        <div className="cl-auth-wrap">
          <div className="cl-auth-card">
            <span className="cl-corner tl" />
            <span className="cl-corner tr" />
            <span className="cl-corner bl" />
            <span className="cl-corner br" />

            <div className="cl-card-strip">
              <span className="seg">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="5" y="11" width="14" height="9" rx="1.5" />
                  <path d="M8 11V8a4 4 0 018 0v3" />
                </svg>
                SECURE LOGIN
              </span>
              <span className="sep">·</span>
              <span className="seg handshake">HANDSHAKE OK</span>
              <span className="grow" />
              <span className="seg">{clock}</span>
            </div>

            <div className="cl-card-body">
              {step === 1 && (
                <form onSubmit={submitStep1}>
                  <div className="cl-step-bar"><i className="active" /><i /></div>
                  <div className="cl-step-label">{t('login.step1.badge')}</div>
                  <h2 className="cl-title">{t('login.step1.title')}</h2>
                  <p className="cl-sub">{t('login.step1.subtitle')}</p>

                  {error && <div className="cl-err">{error}</div>}

                  <div className="cl-field">
                    <div className="cl-field-label"><span>{t('login.step1.username_label')}</span></div>
                    <div className="cl-input-wrap">
                      <span className="ico">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                          <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" />
                        </svg>
                      </span>
                      <input type="text" className="cl-input" placeholder="kullanici.adi"
                        value={username} onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username" autoFocus />
                    </div>
                  </div>

                  <div className="cl-field">
                    <div className="cl-field-label">
                      <span>{t('login.step1.password_label')}</span>
                      <a href="#" onClick={(e) => e.preventDefault()}>{t('login.step1.forgot')}</a>
                    </div>
                    <div className="cl-input-wrap">
                      <span className="ico">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                          <rect x="5" y="11" width="14" height="9" rx="1.5" />
                          <path d="M8 11V8a4 4 0 018 0v3" />
                        </svg>
                      </span>
                      <input className="cl-input" type={showPwd ? 'text' : 'password'} placeholder="••••••••"
                        value={password} onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password" />
                      <button type="button" className="cl-pwd-toggle" onClick={() => setShowPwd((v) => !v)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div className="cl-cb-row">
                    <span className={`box ${remember ? 'on' : ''}`} onClick={() => setRemember(!remember)}>
                      {remember && (
                        <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                          <path d="M3 8.5L6 11.5L13 4.5" stroke="#160f06" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <label onClick={() => setRemember(!remember)}>{t('login.step1.remember')}</label>
                  </div>

                  <button type="submit" className="cl-btn-primary" disabled={loading}>
                    <span className="sheen" />
                    {loading ? t('login.step1.submitting') : t('login.step1.submit')}
                    {!loading && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    )}
                  </button>
                </form>
              )}

              {step === 2 && (
                <div className="cl-mfa-step">
                  <div className="cl-step-bar"><i className="done" /><i className="active" /></div>
                  <button type="button" className="cl-back-btn" onClick={() => { setStep(1); setError('') }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M19 12H5M11 18l-6-6 6-6" />
                    </svg>
                    {t('login.step2.back')}
                  </button>
                  <div className="cl-step-label">{t('login.step2.badge')}</div>
                  <h2 className="cl-title">{t('login.step2.title')}</h2>
                  <p className="cl-sub">
                    {!useRecovery && !useEmail && (
                      <Trans i18nKey="login.step2.hint_totp"
                        components={{ 1: <strong style={{ color: 'var(--c-fg)' }} /> }} />
                    )}
                    {useEmail && !emailSent && t('login.step2.hint_email_pre')}
                    {useEmail && emailSent && (
                      <Trans i18nKey="login.step2.hint_email_post"
                        components={{ 1: <strong style={{ color: 'var(--c-fg)' }} /> }} />
                    )}
                    {useRecovery && (
                      <Trans i18nKey="login.step2.hint_recovery"
                        components={{ 1: <strong style={{ color: 'var(--c-fg)' }} /> }} />
                    )}
                  </p>

                  {(error || emailError) && <div className="cl-err">{error || emailError}</div>}

                  {/* Backend mfa.methods'a göre dinamik segmented control —
                      yalnız sunulan yöntemler buton olarak render edilir */}
                  {(() => {
                    const hasTotp = !mfa.methods || mfa.methods.includes('totp')
                    const hasEmail = mfa.methods?.includes('email') ?? false
                    const hasRecovery = !mfa.methods || mfa.methods.includes('recovery')
                    const totalCount = (hasTotp ? 1 : 0) + (hasEmail ? 1 : 0) + (hasRecovery ? 1 : 0)
                    if (totalCount <= 1) return null
                    return (
                      <div className="cl-mfa-seg">
                        {hasTotp && (
                          <button type="button"
                            className={(!useRecovery && !useEmail) ? 'active' : ''}
                            onClick={() => { setUseRecovery(false); setUseEmail(false); setEmailSent(false); setError(''); setEmailError('') }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                              <rect x="5" y="2" width="14" height="20" rx="2" />
                              <path d="M9 7h6M12 18v.01" />
                            </svg>
                            {t('login.step2.tab_totp')}
                          </button>
                        )}
                        {hasEmail && (
                          <button type="button"
                            className={useEmail ? 'active' : ''}
                            onClick={() => { setUseEmail(true); setUseRecovery(false); setEmailSent(false); setError(''); setEmailError(''); setOtp(['', '', '', '', '', '']) }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                              <rect x="3" y="5" width="18" height="14" rx="2" />
                              <path d="M3 8l9 6 9-6" />
                            </svg>
                            {t('login.step2.tab_email')}
                          </button>
                        )}
                        {hasRecovery && (
                          <button type="button"
                            className={useRecovery ? 'active' : ''}
                            onClick={() => { setUseRecovery(true); setUseEmail(false); setError(''); setEmailError('') }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                              <path d="M12 2l3 6 6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1z" />
                            </svg>
                            {t('login.step2.tab_recovery')}
                          </button>
                        )}
                      </div>
                    )
                  })()}

                  {/* Aktif yöntem için kısa kontekst (masked email vb.) */}
                  <div className="cl-mfa-hint">
                    <span className="ico">
                      {!useRecovery && !useEmail && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <rect x="5" y="2" width="14" height="20" rx="2" />
                          <path d="M9 7h6M12 18v.01" />
                        </svg>
                      )}
                      {useEmail && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <rect x="3" y="5" width="18" height="14" rx="2" />
                          <path d="M3 8l9 6 9-6" />
                        </svg>
                      )}
                      {useRecovery && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <path d="M12 2l3 6 6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1z" />
                        </svg>
                      )}
                    </span>
                    <span>
                      <strong>{methodLabel}</strong> · {methodSub}
                    </span>
                  </div>

                  {/* Input alanı: moda göre */}
                  {useEmail && !emailSent ? (
                    <button type="button" className="cl-btn-primary"
                      disabled={loading} onClick={sendEmailCode} style={{ marginBottom: 12 }}>
                      <span className="sheen" />
                      {loading ? t('login.step2.sending_email') : t('login.step2.send_email')}
                    </button>
                  ) : !useRecovery ? (
                    <div className="cl-otp-row">
                      {otp.map((d, i) => (
                        <input key={i}
                          ref={(el) => { otpRefs.current[i] = el }}
                          className={`cl-otp-input ${d ? 'filled' : ''}`}
                          type="text" inputMode="numeric" maxLength={1}
                          value={d} onChange={(e) => onOtpChange(i, e.target.value)}
                          onKeyDown={(e) => onOtpKey(i, e)} autoFocus={i === 0} />
                      ))}
                    </div>
                  ) : (
                    <input className="cl-input"
                      style={{ padding: '0 12px', textAlign: 'center', letterSpacing: '0.2em', fontSize: 15, textTransform: 'uppercase' }}
                      value={recoveryCode}
                      onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                      placeholder="XXXXX-XXXXX"
                      maxLength={13} autoFocus />
                  )}

                  {!useRecovery && !useEmail && (
                    <div className="cl-resend-row">
                      <span>{t('login.step2.timer_totp')}</span>
                      {timer > 0 && <span className="timer">{`00:${String(timer).padStart(2, '0')}`}</span>}
                    </div>
                  )}
                  {useEmail && emailSent && (
                    <div className="cl-resend-row">
                      <span>{t('login.step2.email_sent_to', { email: mfa.maskedEmail || '' })}</span>
                      <span className="timer clickable" onClick={sendEmailCode}>{t('login.step2.resend')}</span>
                    </div>
                  )}
                  {useRecovery && <div style={{ height: 12 }} />}

                  {(!useEmail || emailSent) && (
                    <button type="button" className="cl-btn-primary"
                      disabled={loading || (useRecovery
                        ? recoveryCode.replace(/[-\s]/g, '').length < 8
                        : otp.join('').length !== 6)}
                      onClick={submitStep2}>
                      <span className="sheen" />
                      {loading ? 'DOĞRULANIYOR…' : 'Doğrula ve Geç'}
                      {!loading && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                          <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
              )}

              {step === 3 && (
                <div style={{ textAlign: 'center', padding: '14px 0 6px' }}>
                  <div className="cl-success-icon">
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" />
                    </svg>
                  </div>
                  <h2 className="cl-title">{t('login.step3.title')}</h2>
                  <p className="cl-sub">{t('login.step3.subtitle')}</p>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'var(--c-font-mono)', fontSize: 10.5, color: 'var(--c-gold)', marginTop: 16, letterSpacing: '0.18em' }}>
                    <span className="cl-live-dot" /> yönlendiriliyor…
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="cl-footer-line">
        Charon <span className="sep">·</span> Enterprise Network Intelligence Platform <span className="sep">·</span> © 2026
      </div>
    </>
  )
}
