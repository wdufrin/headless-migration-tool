import fs from 'fs';
import path from 'path';
import { ValidatedMigrationConfig } from '../config/configSchema.js';
import { SessionMigrator, ChatSession } from './sessionMigrator.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { NotebookLmArtifactFormatter } from '../services/notebookLmArtifactFormatter.js';
import { logger } from '../utils/logger.js';

export interface DiscoveredArtifact {
  id: string;
  type: 'SLIDE_DECK' | 'CANVAS_DOCUMENT' | 'CANVAS_WIDGET' | 'GENERATED_IMAGE' | 'GENERATED_FILE' | 'AUDIO_OVERVIEW';
  sessionTitle: string;
  sessionId: string;
  turnIndex: number;
  userPseudoId: string;
  createdAt?: string;
  title: string;
  description?: string;
  htmlContent?: string;
  rawText?: string;
  slideCount?: number;
  slides?: string[];
  fileMetadata?: {
    mimeType?: string;
    fileId?: string;
  };
}

export class ArtifactExtractor {
  private config: ValidatedMigrationConfig;
  private migrator: SessionMigrator;

  constructor(config: ValidatedMigrationConfig, authService?: GcpAuthService) {
    this.config = config;
    this.migrator = new SessionMigrator(config, authService);
  }

  public async scanAllArtifacts(candidateUsers?: string[]): Promise<DiscoveredArtifact[]> {
    logger.info('Starting full discovery scan for user artifacts across all chat sessions...');
    const users = candidateUsers && candidateUsers.length > 0
      ? candidateUsers
      : (this.config.options?.userFilter ? this.config.options.userFilter.map(f => f.replace(/^user:/, '').trim()) : []);
    const sessions = await this.migrator.listSourceSessions(users);
    const artifacts: DiscoveredArtifact[] = [];

    for (const session of sessions) {
      const sessionTitle = session.displayName || 'Untitled Chat';
      const sessionId = session.name.split('/').pop() || 'unknown';
      const userPseudoId = session.userPseudoId || process.env.DEFAULT_USER_EMAIL || process.env.ADMIN_EMAIL || 'user@example.com';
      const turns = session.turns || [];

      for (let turnIdx = 0; turnIdx < turns.length; turnIdx++) {
        const turn = turns[turnIdx];
        const ansRef = turn.assistAnswer || turn.answer;
        const inlineAnswer = turn.detailedAssistAnswer || turn.detailedAnswer;

        if (inlineAnswer) {
          try {
            const extracted = this.extractArtifactsFromAnswer(inlineAnswer, sessionTitle, sessionId, turnIdx + 1, userPseudoId);
            artifacts.push(...extracted);
          } catch (err: any) {
            logger.warn(`Failed to inspect inline answer for session ${sessionId} turn ${turnIdx + 1}: ${err.message}`);
          }
        } else if (ansRef && typeof ansRef === 'string' && ansRef.startsWith('projects/')) {
          try {
            const ansData = await this.migrator.getAnswer(ansRef, userPseudoId);
            const extracted = this.extractArtifactsFromAnswer(ansData, sessionTitle, sessionId, turnIdx + 1, userPseudoId);
            artifacts.push(...extracted);
          } catch (err: any) {
            logger.warn(`Failed to inspect answer ${ansRef} for artifacts: ${err.message}`);
          }
        }
      }
    }

    logger.info(`Discovered ${artifacts.length} total user artifacts across ${sessions.length} sessions.`);
    return artifacts;
  }

  private extractArtifactsFromAnswer(
    ansData: any,
    sessionTitle: string,
    sessionId: string,
    turnIndex: number,
    userPseudoId: string
  ): DiscoveredArtifact[] {
    const results: DiscoveredArtifact[] = [];

    // 1. Check for Slide Decks in plannerSteps / functionCalls
    const diag = ansData.diagnosticInfo || {};
    const plannerSteps = diag.plannerSteps || [];

    for (const step of plannerSteps) {
      const parts = step.planStep?.parts || [];
      for (const part of parts) {
        const funcCall = part.functionCall;
        if (funcCall && (funcCall.name === 'save_presentation' || funcCall.args?.slides)) {
          const args = funcCall.args || {};
          const slides: string[] = args.slides || [];
          const artifactId = args.artifact_id || `slides_${sessionId}_t${turnIndex}`;
          
          if (slides.length > 0) {
            const fullHtml = this.generateStandaloneSlideDeckHtml(sessionTitle, slides);
            results.push({
              id: artifactId,
              type: 'SLIDE_DECK',
              sessionTitle,
              sessionId,
              turnIndex,
              userPseudoId,
              title: `${sessionTitle} (${slides.length} Slides)`,
              description: `Generated Presentation Deck with ${slides.length} interactive slides`,
              slideCount: slides.length,
              slides,
              htmlContent: fullHtml
            });
          }
        }
      }
    }

    // 2. Check for Immersive Artifacts (Canvas Documents, WebApps, Slides) in replies
    const replies = ansData.replies || [];
    for (let rIdx = 0; rIdx < replies.length; rIdx++) {
      const rep = replies[rIdx];

      // A. Immersive Artifacts (Documents, WebApps, Slide Decks)
      if (rep.immersiveArtifact && Array.isArray(rep.immersiveArtifact)) {
        for (let immIdx = 0; immIdx < rep.immersiveArtifact.length; immIdx++) {
          const imm = rep.immersiveArtifact[immIdx];
          const immTitle = imm.title || sessionTitle || 'Canvas Artifact';

          // Canvas Document (e.g. Banana Report)
          if (imm.docArtifact?.text) {
            const docText = imm.docArtifact.text;
            const fullHtml = this.generateStandaloneDocumentHtml(immTitle, docText);
            results.push({
              id: `doc_${sessionId}_t${turnIndex}_r${rIdx}_${immIdx}`,
              type: 'CANVAS_DOCUMENT',
              sessionTitle,
              sessionId,
              turnIndex,
              userPseudoId,
              title: immTitle,
              description: `Interactive Canvas Document (${docText.split(/\s+/).length} words)`,
              rawText: docText,
              htmlContent: fullHtml
            });
          }

          // Slides Artifact
          if (imm.slidesArtifact?.slides && Array.isArray(imm.slidesArtifact.slides)) {
            const slides = imm.slidesArtifact.slides.map((s: any) => s.code || s).filter(Boolean);
            if (slides.length > 0) {
              const fullHtml = this.generateStandaloneSlideDeckHtml(immTitle, slides);
              results.push({
                id: `slides_imm_${sessionId}_t${turnIndex}_r${rIdx}_${immIdx}`,
                type: 'SLIDE_DECK',
                sessionTitle,
                sessionId,
                turnIndex,
                userPseudoId,
                title: `${immTitle} (${slides.length} Slides)`,
                description: `Generated Presentation Deck with ${slides.length} interactive slides`,
                slideCount: slides.length,
                slides,
                htmlContent: fullHtml
              });
            }
          }

          // Code / WebApp Artifact (e.g. Tetris)
          if (imm.codeArtifact?.files && Array.isArray(imm.codeArtifact.files)) {
            const fullHtml = this.generateStandaloneCodeAppHtml(immTitle, imm.codeArtifact.files);
            results.push({
              id: `code_imm_${sessionId}_t${turnIndex}_r${rIdx}_${immIdx}`,
              type: 'CANVAS_WIDGET',
              sessionTitle,
              sessionId,
              turnIndex,
              userPseudoId,
              title: immTitle,
              description: `Interactive Canvas Web Application (${imm.codeArtifact.files.length} file(s))`,
              htmlContent: fullHtml
            });
          }
        }
      }

      const content = rep.groundedContent?.content;
      if (!content) continue;

      // B. A2UI Interactive Canvas Side-Panel
      if (content.inlineData?.mimeType === 'application/json+a2ui' && content.inlineData.data) {
        try {
          let b64 = content.inlineData.data;
          const pad = b64.length % 4;
          if (pad) b64 += '='.repeat(4 - pad);
          const decoded = Buffer.from(b64, 'base64').toString('utf-8');
          
          let widgetHtml = '';
          const match = decoded.match(/"literalString":\s*"([\s\S]*?)"\s*\}\s*\}\s*\}\s*\]/);
          if (match) {
            try {
              widgetHtml = JSON.parse(`"${match[1]}"`);
            } catch {
              widgetHtml = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
            }
          }

          if (widgetHtml) {
            const widgetTitle = (widgetHtml.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i)?.[1] || 'Interactive Canvas').replace(/<[^>]+>/g, '').trim();
            results.push({
              id: `canvas_${sessionId}_t${turnIndex}_r${rIdx}`,
              type: 'CANVAS_WIDGET',
              sessionTitle,
              sessionId,
              turnIndex,
              userPseudoId,
              title: widgetTitle,
              description: `A2UI Interactive Side-Panel Canvas Component`,
              htmlContent: widgetHtml
            });
          }
        } catch (e: any) {
          logger.warn(`Failed to decode A2UI widget: ${e.message}`);
        }
      }

      // C. Generated Images / Audio Overviews / Media
      if (content.file) {
        const file = content.file;
        const isImg = file.mimeType?.startsWith('image/');
        const isAudio = file.mimeType?.startsWith('audio/') || file.fileName?.endsWith('.mp3') || file.fileName?.endsWith('.wav') || file.fileName?.endsWith('.m4a');
        const artifactType = isAudio ? 'AUDIO_OVERVIEW' : isImg ? 'GENERATED_IMAGE' : 'GENERATED_FILE';
        const typeLabel = isAudio ? 'Audio Overview' : isImg ? 'Image' : 'File';
        const artifactTitle = `Generated ${typeLabel} (${file.mimeType || 'unknown'})`;
        const audioHtml = isAudio ? this.generateStandaloneAudioOverviewHtml(artifactTitle, file) : undefined;

        results.push({
          id: `file_${sessionId}_t${turnIndex}_${file.fileId || rIdx}`,
          type: artifactType,
          sessionTitle,
          sessionId,
          turnIndex,
          userPseudoId,
          title: artifactTitle,
          description: `Asset ID: ${file.fileId || 'N/A'}${isAudio ? ' [Deep Dive Audio Podcast / Overview]' : ''}`,
          htmlContent: audioHtml,
          fileMetadata: {
            mimeType: file.mimeType,
            fileId: file.fileId
          }
        });
      }
    }

    // Deduplicate by ID
    const seen = new Set<string>();
    return results.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }

  public generateStandaloneSlideDeckHtml(title: string, slides: string[]): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Presentation Deck</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #030712; color: #f9fafb; font-family: system-ui, -apple-system, sans-serif; }
    .slide-wrapper { display: none; width: 100%; min-height: 520px; }
    .slide-wrapper.active { display: flex; animation: fadeIn 0.3s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; transform: scale(0.99); } to { opacity: 1; transform: scale(1); } }
    .slide-container { width: 100%; min-height: 520px; border-radius: 1.25rem; }
  </style>
</head>
<body class="min-h-screen flex flex-col items-center justify-center p-6 bg-slate-950">
  <div class="w-full max-w-5xl bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col">
    <!-- Header -->
    <div class="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
      <div class="flex items-center gap-3">
        <span class="text-xl">📊</span>
        <div>
          <h1 class="text-sm font-bold text-white">${title}</h1>
          <p class="text-xs text-slate-400">Gemini Enterprise Presentation Artifact (${slides.length} Slides)</p>
        </div>
      </div>
      <div class="flex items-center gap-2 text-xs font-mono text-slate-400">
        <span id="slideIndicator">Slide 1 of ${slides.length}</span>
      </div>
    </div>

    <!-- Slides Viewport -->
    <div class="p-8 flex-1 flex items-center justify-center bg-slate-950/40">
      ${slides.map((s, idx) => `
        <div id="slide-${idx}" class="slide-wrapper ${idx === 0 ? 'active' : ''}">
          ${s}
        </div>
      `).join('')}
    </div>

    <!-- Navigation Footer -->
    <div class="px-6 py-4 border-t border-slate-800 flex items-center justify-between bg-slate-950/80">
      <button onclick="prevSlide()" id="btnPrev" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition disabled:opacity-30 disabled:cursor-not-allowed">
        ← Previous Slide
      </button>
      <div class="flex items-center gap-1.5">
        ${slides.map((_, idx) => `
          <button onclick="goToSlide(${idx})" id="dot-${idx}" class="w-2.5 h-2.5 rounded-full ${idx === 0 ? 'bg-cyan-400' : 'bg-slate-700'} transition"></button>
        `).join('')}
      </div>
      <button onclick="nextSlide()" id="btnNext" class="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-cyan-600/30 transition disabled:opacity-30 disabled:cursor-not-allowed">
        Next Slide →
      </button>
    </div>
  </div>

  <script>
    let currentIdx = 0;
    const total = ${slides.length};

    function updateView() {
      for (let i = 0; i < total; i++) {
        const el = document.getElementById('slide-' + i);
        const dot = document.getElementById('dot-' + i);
        if (el) el.classList.toggle('active', i === currentIdx);
        if (dot) {
          dot.className = 'w-2.5 h-2.5 rounded-full transition ' + (i === currentIdx ? 'bg-cyan-400' : 'bg-slate-700');
        }
      }
      document.getElementById('slideIndicator').textContent = 'Slide ' + (currentIdx + 1) + ' of ' + total;
      document.getElementById('btnPrev').disabled = currentIdx === 0;
      document.getElementById('btnNext').disabled = currentIdx === total - 1;
    }

    function prevSlide() { if (currentIdx > 0) { currentIdx--; updateView(); } }
    function nextSlide() { if (currentIdx < total - 1) { currentIdx++; updateView(); } }
    function goToSlide(idx) { currentIdx = idx; updateView(); }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'Space') nextSlide();
      if (e.key === 'ArrowLeft') prevSlide();
    });

    updateView();
  </script>
</body>
</html>`;
  }

  public generateStandaloneDocumentHtml(title: string, markdownText: string): string {
    const safeTitle = title.replace(/"/g, '&quot;');
    const words = markdownText.trim().split(/\s+/).length;
    const readingTimeMin = Math.max(1, Math.ceil(words / 200));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} - Canvas Document</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #030712; color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .prose h1 { color: #ffffff; font-weight: 800; font-size: 1.875rem; margin-top: 1.5rem; margin-bottom: 1rem; border-bottom: 1px solid #1f2937; padding-bottom: 0.5rem; }
    .prose h2 { color: #f9fafb; font-weight: 700; font-size: 1.5rem; margin-top: 1.5rem; margin-bottom: 0.75rem; }
    .prose h3 { color: #f3f4f6; font-weight: 600; font-size: 1.25rem; margin-top: 1.25rem; margin-bottom: 0.5rem; }
    .prose p { color: #d1d5db; line-height: 1.75; margin-bottom: 1rem; }
    .prose ul { list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem; color: #d1d5db; }
    .prose ol { list-style-type: decimal; padding-left: 1.5rem; margin-bottom: 1rem; color: #d1d5db; }
    .prose li { margin-bottom: 0.375rem; }
    .prose blockquote { border-left: 4px solid #3b82f6; padding-left: 1rem; color: #9ca3af; font-style: italic; margin: 1rem 0; background: #111827; padding-top: 0.5rem; padding-bottom: 0.5rem; border-radius: 0 0.5rem 0.5rem 0; }
    .prose code { background-color: #1f2937; color: #60a5fa; padding: 0.2rem 0.4rem; border-radius: 0.375rem; font-family: monospace; font-size: 0.875em; }
    .prose pre { background-color: #0f172a; border: 1px solid #1e293b; border-radius: 0.75rem; padding: 1rem; overflow-x: auto; margin-bottom: 1rem; }
    .prose pre code { background-color: transparent; color: #e2e8f0; padding: 0; }
    .prose table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
    .prose th, .prose td { border: 1px solid #374151; padding: 0.75rem; text-align: left; }
    .prose th { background-color: #1f2937; color: #ffffff; }
    .prose tr:nth-child(even) { background-color: #111827; }
    .prose a { color: #38bdf8; text-decoration: underline; }
    .prose a:hover { color: #7dd3fc; }
  </style>
</head>
<body class="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-8">
  <div class="max-w-4xl mx-auto bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
    <!-- Document Header -->
    <div class="px-8 py-6 border-b border-slate-800 bg-slate-950/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <div class="flex items-center gap-2 text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-1">
          <span>📄 Canvas Document Artifact</span>
        </div>
        <h1 class="text-xl sm:text-2xl font-extrabold text-white">${safeTitle}</h1>
        <div class="flex items-center gap-4 text-xs text-slate-400 mt-2">
          <span><i class="fa-solid fa-file-lines mr-1"></i> ${words.toLocaleString()} words</span>
          <span><i class="fa-solid fa-clock mr-1"></i> ~${readingTimeMin} min read</span>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="copyMarkdown()" id="btnCopy" class="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold border border-slate-700 transition flex items-center gap-1.5">
          <i class="fa-regular fa-copy"></i> Copy Markdown
        </button>
        <button onclick="window.print()" class="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition flex items-center gap-1.5">
          <i class="fa-solid fa-print"></i> Print / PDF
        </button>
      </div>
    </div>

    <!-- Document Content -->
    <div class="p-8 sm:p-12">
      <div id="content" class="prose max-w-none"></div>
    </div>
  </div>

  <textarea id="rawMarkdown" class="hidden">${markdownText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>

  <script>
    const raw = document.getElementById('rawMarkdown').value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    document.getElementById('content').innerHTML = marked.parse(raw);

    function copyMarkdown() {
      navigator.clipboard.writeText(raw).then(() => {
        const btn = document.getElementById('btnCopy');
        const old = btn.innerHTML;
        btn.innerHTML = '<i class=\"fa-solid fa-check text-emerald-400\"></i> Copied!';
        setTimeout(() => btn.innerHTML = old, 2000);
      });
    }
  </script>
</body>
</html>`;
  }

  public generateStandaloneCodeAppHtml(title: string, files: any[]): string {
    const safeTitle = title.replace(/"/g, '&quot;');
    const indexFile = files.find(f => f.filePath === 'index.html' || f.filePath?.endsWith('.html')) || files[0];
    const rawHtml = indexFile ? (indexFile.content || '') : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} - Canvas WebApp</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #030712; color: #f9fafb; margin: 0; overflow: hidden; height: 100vh; font-family: system-ui, sans-serif; }
  </style>
</head>
<body class="flex flex-col h-screen">
  <!-- Top Bar -->
  <div class="h-12 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between flex-shrink-0">
    <div class="flex items-center gap-2">
      <span class="text-emerald-400 text-sm">🎮</span>
      <span class="text-sm font-bold text-white">${safeTitle}</span>
      <span class="text-xs text-slate-500">Interactive Canvas WebApp (${files.length} file(s))</span>
    </div>
    <div class="flex items-center gap-2">
      <button onclick="document.getElementById('appFrame').srcdoc = document.getElementById('appFrame').srcdoc" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-xs text-white rounded-lg transition" title="Restart Application">
        <i class="fa-solid fa-rotate-right mr-1"></i> Restart
      </button>
    </div>
  </div>

  <!-- App Viewport -->
  <div class="flex-1 bg-black flex items-center justify-center relative overflow-hidden">
    <iframe id="appFrame" class="w-full h-full border-0" sandbox="allow-scripts allow-forms allow-modals allow-same-origin"></iframe>
  </div>

  <textarea id="appSource" class="hidden">${rawHtml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>

  <script>
    const src = document.getElementById('appSource').value.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    document.getElementById('appFrame').srcdoc = src;
  </script>
</body>
</html>`;
  }

  public generateStandaloneAudioOverviewHtml(title: string, fileMetadata: any): string {
    const safeTitle = title.replace(/"/g, '&quot;');
    const mime = fileMetadata?.mimeType || 'audio/mpeg';
    const fileId = fileMetadata?.fileId || 'N/A';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} - Audio Overview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #030712; color: #f9fafb; font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body class="min-h-screen flex items-center justify-center p-6 bg-slate-950">
  <div class="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl flex flex-col items-center text-center">
    <div class="w-20 h-20 rounded-2xl bg-indigo-600/20 text-indigo-400 flex items-center justify-center text-3xl mb-4 border border-indigo-500/30 shadow-lg shadow-indigo-500/10">
      <i class="fa-solid fa-podcast"></i>
    </div>
    <span class="px-3 py-1 bg-indigo-950 text-indigo-400 text-xs font-semibold rounded-full border border-indigo-800 mb-2">NotebookLM / Deep Dive Audio</span>
    <h1 class="text-xl font-bold text-white mb-2">${safeTitle}</h1>
    <p class="text-xs text-slate-400 mb-6">Autonomous multi-speaker podcast audio overview generated by Gemini Enterprise Studio.</p>

    <div class="w-full bg-slate-950/80 rounded-2xl p-4 border border-slate-800 flex flex-col gap-2 text-left mb-6">
      <div class="flex justify-between text-xs text-slate-400">
        <span>File ID</span>
        <span class="font-mono text-indigo-300">\${fileId}</span>
      </div>
      <div class="flex justify-between text-xs text-slate-400">
        <span>MIME Type</span>
        <span class="font-mono text-slate-300">\${mime}</span>
      </div>
      <div class="flex justify-between text-xs text-slate-400">
        <span>Archived Status</span>
        <span class="text-emerald-400 font-semibold">✓ Preserved Offline</span>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  public async exportAllToDirectory(outputDir: string = './exports/artifacts', candidateUsers?: string[]): Promise<{ count: number; exportDir: string }> {
    const artifacts = await this.scanAllArtifacts(candidateUsers);
    const resolvedDir = path.resolve(process.cwd(), outputDir);

    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }

    const exportedManifests: any[] = [];

    for (const art of artifacts) {
      const sessionSlug = art.sessionTitle.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      const sessionDir = path.join(resolvedDir, sessionSlug);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      const safeId = art.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const cleanBase = NotebookLmArtifactFormatter.cleanArtifactFilename(art.sessionTitle, art.title, '').replace(/\.[^/.]+$/, '');
      const exportedFiles: string[] = [];

      try {
        if (art.type === 'SLIDE_DECK') {
          const textContent = (art.slides && art.slides.length > 0)
            ? art.slides.join('\n\n---\n\n')
            : (art.rawText || '');

          // 1. Native Microsoft PowerPoint (.pptx)
          const pptxFilename = `${cleanBase}.pptx`;
          const pptxPath = path.join(sessionDir, pptxFilename);
          await NotebookLmArtifactFormatter.generatePptxPresentation(art.title, art.sessionTitle, textContent, pptxPath);
          exportedFiles.push(pptxFilename);

          // 2. Interactive Presentation HTML
          const deckHtml = NotebookLmArtifactFormatter.renderSlideDeckPresentation(art.title, art.sessionTitle, textContent);
          const deckFilename = `${cleanBase}_SlideDeck.html`;
          fs.writeFileSync(path.join(sessionDir, deckFilename), deckHtml, 'utf8');
          fs.writeFileSync(path.join(sessionDir, `${safeId}.html`), deckHtml, 'utf8');
          exportedFiles.push(deckFilename);

          // 3. Clean authentic Markdown
          const cleanMd = NotebookLmArtifactFormatter.cleanNotebookLmMarkdown(art.title, textContent);
          const mdFilename = `${cleanBase}.md`;
          fs.writeFileSync(path.join(sessionDir, mdFilename), cleanMd, 'utf8');
          fs.writeFileSync(path.join(sessionDir, `${safeId}.md`), cleanMd, 'utf8');
          exportedFiles.push(mdFilename);
        } else if (art.type === 'CANVAS_DOCUMENT') {
          const textContent = art.rawText || '';

          // 1. Native Microsoft Word (.docx)
          const docxFilename = `${cleanBase}.docx`;
          const docxPath = path.join(sessionDir, docxFilename);
          await NotebookLmArtifactFormatter.generateDocxDocument(art.title, 'Canvas Document', art.sessionTitle, textContent, docxPath);
          exportedFiles.push(docxFilename);

          // 2. Executive HTML Document
          const docHtml = NotebookLmArtifactFormatter.renderDocumentHtml(art.title, 'Canvas Document', art.sessionTitle, textContent);
          const htmlFilename = `${cleanBase}.html`;
          fs.writeFileSync(path.join(sessionDir, htmlFilename), docHtml, 'utf8');
          fs.writeFileSync(path.join(sessionDir, `${safeId}.html`), docHtml, 'utf8');
          exportedFiles.push(htmlFilename);

          // 3. Clean authentic Markdown
          const cleanMd = NotebookLmArtifactFormatter.cleanNotebookLmMarkdown(art.title, textContent);
          const mdFilename = `${cleanBase}.md`;
          fs.writeFileSync(path.join(sessionDir, mdFilename), cleanMd, 'utf8');
          fs.writeFileSync(path.join(sessionDir, `${safeId}.md`), cleanMd, 'utf8');
          exportedFiles.push(mdFilename);
        } else {
          if (art.htmlContent) {
            const htmlFilename = `${cleanBase}.html`;
            fs.writeFileSync(path.join(sessionDir, htmlFilename), art.htmlContent, 'utf8');
            fs.writeFileSync(path.join(sessionDir, `${safeId}.html`), art.htmlContent, 'utf8');
            exportedFiles.push(htmlFilename);
          }
          if (art.rawText) {
            const cleanMd = NotebookLmArtifactFormatter.cleanNotebookLmMarkdown(art.title, art.rawText);
            const mdFilename = `${cleanBase}.md`;
            fs.writeFileSync(path.join(sessionDir, mdFilename), cleanMd, 'utf8');
            fs.writeFileSync(path.join(sessionDir, `${safeId}.md`), cleanMd, 'utf8');
            exportedFiles.push(mdFilename);
          }
        }
      } catch (exportErr: any) {
        logger.warn(`Failed to export rich format for artifact "${art.title}" (${art.id}): ${exportErr.message}`);
        // Fallback to raw files
        if (art.htmlContent) fs.writeFileSync(path.join(sessionDir, `${safeId}.html`), art.htmlContent, 'utf8');
        if (art.rawText) fs.writeFileSync(path.join(sessionDir, `${safeId}.md`), art.rawText, 'utf8');
      }

      fs.writeFileSync(path.join(sessionDir, `${safeId}.meta.json`), JSON.stringify(art, null, 2), 'utf8');
      exportedManifests.push({
        ...art,
        cleanBaseName: cleanBase,
        exportedFiles,
        sessionDirectory: sessionSlug
      });
    }

    // Write Master Manifest
    fs.writeFileSync(path.join(resolvedDir, 'manifest.json'), JSON.stringify({
      exportedAt: new Date().toISOString(),
      totalArtifacts: artifacts.length,
      artifacts: exportedManifests
    }, null, 2), 'utf8');

    logger.info(`Successfully exported ${artifacts.length} artifacts to ${resolvedDir}`);
    return { count: artifacts.length, exportDir: resolvedDir };
  }
}
