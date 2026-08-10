import { escapeHtml as esc, markdownToWordHtml } from './format.js';

export function downloadBrief({ form, sliders, portfolioProfile, chits, poiCount, selectedTargets = [], modelInfo, targetMode }) {
  const targetSummary = selectedTargets.length ? selectedTargets.map((target) => `${target.name} (${target.iso})`).join(', ') : 'Auto-discovery / Gemini-selected targets';
  const sections = chits.map((chit, index) => `<section class="target">
    <h2>POI #${String(index + 1).padStart(2, '0')} — ${esc(chit.target)}</h2>
    <table><tr><td>Target</td><td>${esc(chit.target)}</td></tr><tr><td>Pressure Score</td><td>${chit.pressureProfile?.score}/100</td></tr><tr><td>Classification</td><td>${esc(chit.pressureProfile?.classification)}</td></tr><tr><td>Aggression</td><td>${chit.pressureProfile?.aggression ?? sliders.aggression}%</td></tr><tr><td>Controversy</td><td>${chit.pressureProfile?.controversy ?? sliders.controversy}%</td></tr><tr><td>Diplomacy</td><td>${chit.pressureProfile?.diplomacy ?? sliders.diplomacy}%</td></tr><tr><td>Length</td><td>${chit.pressureProfile?.length ?? sliders.length}%</td></tr></table>
    <h3>QUESTION</h3><blockquote>${markdownToWordHtml(chit.poi)}</blockquote><p><b>Word Count:</b> ${chit.wordCount} words<br><b>Estimated Time:</b> ~${chit.estimatedSeconds} seconds</p>
    <h3>LEGAL FOUNDATION</h3><p>${esc(chit.legalPolicyFoundation)}</p>
    <h3>EVIDENCE</h3>${(chit.evidence || []).map((e) => `<p><b>${esc(e.title || e.source)}</b><br>${esc(e.organization || e.publication || 'VERIFICATION REQUIRED')} · ${esc(e.date || 'VERIFICATION REQUIRED')} · ${esc(e.sourceClassification || 'VERIFICATION REQUIRED')}<br>${e.url ? esc(e.url) : 'VERIFICATION REQUIRED'}<br><b>Claim:</b> ${esc(e.claim)}</p>`).join('')}
    <h3>DOCUMENTED CONTRADICTION</h3><p><b>Portfolio position:</b> ${esc(chit.pressurePoint?.portfolioPosition)}</p><p><b>Target position/action:</b> ${esc(chit.pressurePoint?.targetPositionAction)}</p><p><b>Conflict:</b> ${esc(chit.pressurePoint?.conflict)}</p><p><b>Agenda relevance:</b> ${esc(chit.pressurePoint?.agendaRelevance)}</p>
    <h3>TACTICAL IMPACT</h3><p>${esc(chit.tacticalImpact)}</p><p><b>Legal / Tactical Classification:</b> ${esc((chit.legalTacticalTypes || []).join(', '))}</p><h3>FACT CHECK STATUS</h3><p><b>Status:</b> ${esc(chit.factCheck?.status || 'review')}<br><b>Confidence:</b> ${esc(chit.factCheck?.confidence ?? 0)}%</p>
    ${chit.followUp ? `<h3>OPTIONAL FOLLOW-UP</h3><p><b>Expected evasion:</b> ${esc(chit.followUp.expectedEvasion)}</p><p><b>Follow-up:</b> ${esc(chit.followUp.question)}</p>` : ''}
  </section>`).join('<br style="page-break-after:always">');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Aptos,Arial,sans-serif;color:#111;line-height:1.45} h1{color:#8a6813;border-bottom:5px solid #D4AF37;padding-bottom:12px} h2{color:#6e5412;border-top:2px solid #D4AF37;padding-top:16px} h3{color:#8a6813;text-transform:uppercase;font-size:11pt;letter-spacing:.08em} blockquote{border-left:8px solid #D4AF37;background:#fff8df;padding:14px 18px;font-size:16pt} table{border-collapse:collapse;width:100%;margin:10px 0} td{border:1px solid #d7c57d;padding:8px} .target{page-break-after:always} footer{mso-element:footer;color:#777;font-size:9pt}
  </style></head><body><h1>CHITFORGE<br>TACTICAL POI BRIEF</h1><p><b>COMMITTEE:</b> ${esc(form.committee || 'Unspecified')}<br><b>AGENDA:</b> ${esc(form.agenda)}<br><b>PORTFOLIO:</b> ${esc(form.portfolio)}<br><b>TARGET MODE:</b> ${esc(targetMode || 'Selected + Global Research')}<br><b>TARGETS:</b> ${esc(targetSummary)}<br><b>PRIMARY MODEL:</b> ${esc(modelInfo?.model?.displayName || 'Not recorded')}<br><b>FACT CHECK MODEL:</b> ${esc(modelInfo?.factCheckModel || '2-pass verification')}<br><b>NUMBER OF POIs:</b> ${chits.length}${poiCount ? ` / ${poiCount} requested` : ''}<br><b>DATE:</b> ${new Date().toLocaleString()}</p><h2>PORTFOLIO INTELLIGENCE SUMMARY</h2><p>${esc(portfolioProfile?.summary || 'VERIFICATION REQUIRED')}</p><p><b>Interests:</b> ${esc((portfolioProfile?.interests || []).join('; '))}</p>${sections}<footer>ChitForge tactical brief · generated locally in browser</footer></body></html>`;
  const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'ChitForge-Tactical-POI-Brief.docx';
  link.click();
  URL.revokeObjectURL(link.href);
}
