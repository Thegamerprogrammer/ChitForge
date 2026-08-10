import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } from 'docx';
import { stripMarkdown } from './format.js';

function boldRuns(text) {
  const runs = [];
  String(text || '').split(/(\*\*.*?\*\*)/g).filter(Boolean).forEach((part) => {
    const bold = part.startsWith('**') && part.endsWith('**');
    runs.push(new TextRun({ text: bold ? part.slice(2, -2) : part, bold }));
  });
  return runs.length ? runs : [new TextRun('Verification required')];
}
const line = (label, value) => new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true, color: 'D4AF37' }), new TextRun(String(value ?? 'Verification required'))], spacing: { after: 100 } });
const heading = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, thematicBreak: false, spacing: { before: 280, after: 120 }, border: { top: { style: BorderStyle.SINGLE, size: 8, color: 'D4AF37' } } });

export async function downloadBrief({ form, sliders, portfolioProfile, chits, poiCount, selectedTargets = [], modelInfo, targetMode }) {
  const children = [
    new Paragraph({ text: 'CHITFORGE', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: 'TACTICAL POI BRIEF', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: 'D4AF37' } } }),
    line('Committee', form.committee || 'Unspecified'), line('Agenda', form.agenda), line('Portfolio', form.portfolio), line('Target Mode', targetMode || 'Selected + Global Research'), line('POI Count', `${chits.length}${poiCount ? ` / ${poiCount} requested` : ''}`), line('Primary Model', modelInfo?.model?.displayName || 'Not recorded'), line('Fact Check Model', modelInfo?.factCheckModel || '2-pass verification'), line('Targets', selectedTargets.length ? selectedTargets.map((t) => `${t.name} (${t.iso})`).join(', ') : 'Auto-discovery / Gemini-selected targets'),
    heading('PORTFOLIO INTELLIGENCE SUMMARY'), new Paragraph(stripMarkdown(portfolioProfile?.summary || 'Verification required')),
  ];
  chits.forEach((chit, index) => {
    children.push(heading(`POI NUMBER ${index + 1}`), line('Target', chit.target), new Paragraph({ children: [new TextRun({ text: 'QUESTION', bold: true, color: 'D4AF37' })], spacing: { before: 120, after: 80 } }), new Paragraph({ children: boldRuns(chit.poi), border: { left: { style: BorderStyle.SINGLE, size: 16, color: 'D4AF37' } }, spacing: { after: 160 } }), line('Pressure Score', `${chit.pressureScore ?? chit.pressureProfile?.score}/100`), line('Aggression', chit.aggression ?? sliders.aggression), line('Controversy', chit.controversy ?? sliders.controversy), line('Diplomacy', chit.diplomacy ?? sliders.diplomacy), line('Length', chit.length ?? sliders.length), line('Word Count', `${chit.wordCount} words`), line('Estimated Speaking Time', `${chit.estimatedSeconds} seconds`), line('Classification', chit.classification || chit.pressureProfile?.classification), line('Legal Foundation', chit.legalFoundation || chit.legalPolicyFoundation), heading('EVIDENCE'));
    (chit.evidence || []).forEach((e) => children.push(line(e.sourceName || e.title || 'Source', `${e.claim || 'Verification required'} — ${e.sourceUrl || e.url || 'Verification required'}`)));
    children.push(line('Documented Issue', chit.documentedIssue || chit.pressurePoint?.conflict), line('Tactical Impact', chit.tacticalImpact), line('Fact Check Status', `${chit.factCheck?.status || 'review'} (${chit.factCheck?.confidence ?? 0}%)`));
    if (chit.followUp) children.push(line('Follow-up', chit.followUp.question || chit.followUp));
  });
  const doc = new Document({ sections: [{ properties: {}, children }] });
  const blob = await Packer.toBlob(doc);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'ChitForge-Tactical-POI-Brief.docx';
  link.click();
  URL.revokeObjectURL(link.href);
}
