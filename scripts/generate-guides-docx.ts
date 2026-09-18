/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  PageNumber,
  Header,
  Footer,
  ImageRun,
  ShadingType
} from 'docx';

interface CalloutOptions {
  title: string;
  text: string;
  type?: 'note' | 'tip' | 'warning' | 'important';
}

class DocxGuideBuilder {
  private children: Array<Paragraph | Table> = [];
  private docTitle: string;

  constructor(title: string) {
    this.docTitle = title;
  }

  public addCoverHeader(mainTitle: string, subtitle: string, meta: { [key: string]: string }): void {
    // Top colored accent bar
    this.children.push(
      new Paragraph({
        border: { top: { color: '1A73E8', size: 36, style: BorderStyle.SINGLE, space: 1 } },
        spacing: { before: 100, after: 180 }
      })
    );

    // Document Title
    this.children.push(
      new Paragraph({
        text: mainTitle,
        heading: HeadingLevel.TITLE,
        spacing: { after: 120 }
      })
    );

    // Subtitle
    this.children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: subtitle,
            font: 'Arial',
            size: 24,
            color: '475569',
            italics: true
          })
        ],
        spacing: { after: 240 }
      })
    );

    // Metadata Table
    const metaRows: TableRow[] = Object.entries(meta).map(([key, value]) => {
      return new TableRow({
        children: [
          new TableCell({
            width: { size: 30, type: WidthType.PERCENTAGE },
            shading: { fill: 'F1F5F9' },
            margins: { top: 80, bottom: 80, left: 140, right: 140 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: key, bold: true, font: 'Arial', size: 19, color: '0F172A' })]
              })
            ]
          }),
          new TableCell({
            width: { size: 70, type: WidthType.PERCENTAGE },
            shading: { fill: 'FFFFFF' },
            margins: { top: 80, bottom: 80, left: 140, right: 140 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: value, font: 'Arial', size: 19, color: '334155' })]
              })
            ]
          })
        ]
      });
    });

    this.children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
          left: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
          right: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
          insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' }
        },
        rows: metaRows
      })
    );

    // Divider line
    this.children.push(
      new Paragraph({
        border: { bottom: { color: 'E2E8F0', size: 6, style: BorderStyle.SINGLE, space: 100 } },
        spacing: { before: 240, after: 280 }
      })
    );
  }

  public addHeading1(text: string): void {
    this.children.push(
      new Paragraph({
        text,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 140 }
      })
    );
  }

  public addHeading2(text: string): void {
    this.children.push(
      new Paragraph({
        text,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 280, after: 120 }
      })
    );
  }

  public addHeading3(text: string): void {
    this.children.push(
      new Paragraph({
        text,
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 80 }
      })
    );
  }

  public addParagraph(text: string): void {
    this.children.push(
      new Paragraph({
        children: this.parseInlineTokens(text),
        spacing: { after: 120, line: 276 }
      })
    );
  }

  public addBullet(text: string, level: number = 0): void {
    this.children.push(
      new Paragraph({
        bullet: { level },
        children: this.parseInlineTokens(text),
        spacing: { after: 60, line: 260 }
      })
    );
  }

  public addNumbered(text: string, num: number): void {
    this.children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${num}.  `, bold: true, font: 'Arial', size: 21, color: '1A73E8' }),
          ...this.parseInlineTokens(text)
        ],
        spacing: { after: 80, line: 260 },
        indent: { left: 360, hanging: 360 }
      })
    );
  }

  public addCallout(options: CalloutOptions): void {
    const type = options.type || 'note';
    let borderColor = '1A73E8'; // Blue (Note)
    let bgColor = 'F0F7FF';
    let icon = '📌 NOTE';

    if (type === 'tip') {
      borderColor = '16A34A'; // Green
      bgColor = 'F0FDF4';
      icon = '💡 TIP';
    } else if (type === 'warning') {
      borderColor = 'EA580C'; // Orange
      bgColor = 'FFF7ED';
      icon = '⚠️ WARNING';
    } else if (type === 'important') {
      borderColor = 'DC2626'; // Red
      bgColor = 'FEF2F2';
      icon = '🚨 CRITICAL';
    }

    this.children.push(
      new Paragraph({
        indent: { left: 400, right: 200 },
        border: { left: { color: borderColor, size: 24, style: BorderStyle.SINGLE, space: 140 } },
        shading: { fill: bgColor },
        children: [
          new TextRun({ text: `${icon}: `, bold: true, font: 'Arial', size: 20, color: borderColor }),
          new TextRun({ text: `${options.title}\n`, bold: true, font: 'Arial', size: 20, color: '0F172A' }),
          ...this.parseInlineTokens(options.text)
        ],
        spacing: { before: 140, after: 160 }
      })
    );
  }

  public addCodeBlock(code: string): void {
    const lines = code.trim().split('\n');
    const runs: TextRun[] = [];

    lines.forEach((line, idx) => {
      runs.push(
        new TextRun({
          text: line + (idx < lines.length - 1 ? '\n' : ''),
          font: 'Consolas',
          size: 19,
          color: '0F172A'
        })
      );
    });

    this.children.push(
      new Paragraph({
        indent: { left: 400, right: 200 },
        border: {
          top: { color: 'CBD5E1', size: 6, style: BorderStyle.SINGLE, space: 60 },
          bottom: { color: 'CBD5E1', size: 6, style: BorderStyle.SINGLE, space: 60 },
          left: { color: '3B82F6', size: 18, style: BorderStyle.SINGLE, space: 100 },
          right: { color: 'CBD5E1', size: 6, style: BorderStyle.SINGLE, space: 60 }
        },
        shading: { fill: 'F8FAFC' },
        children: runs,
        spacing: { before: 120, after: 140 }
      })
    );
  }

  public addImage(imagePath: string, caption: string, width = 560, height = 350): void {
    const fullPath = path.resolve(process.cwd(), imagePath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`[WARN] Image not found: ${fullPath}`);
      return;
    }

    const imgBuffer = fs.readFileSync(fullPath);
    const isPng = imgBuffer.length >= 8 && imgBuffer[0] === 0x89 && imgBuffer[1] === 0x50;
    const imgType: 'png' | 'jpg' = isPng ? 'png' : 'jpg';

    // Center-aligned Image
    this.children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: imgBuffer,
            type: imgType,
            transformation: { width, height }
          })
        ],
        spacing: { before: 160, after: 80 }
      })
    );

    // Caption
    this.children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: caption,
            italics: true,
            size: 18,
            color: '64748B',
            font: 'Arial'
          })
        ],
        spacing: { after: 200 }
      })
    );
  }

  public addTable(headers: string[], rows: string[][], colWidthPercentages?: number[]): void {
    const tableRows: TableRow[] = [];

    // Header Row
    tableRows.push(
      new TableRow({
        tableHeader: true,
        children: headers.map((h, idx) => {
          const widthVal = colWidthPercentages ? colWidthPercentages[idx] : Math.floor(100 / headers.length);
          return new TableCell({
            width: { size: widthVal, type: WidthType.PERCENTAGE },
            shading: { fill: '1E293B' },
            margins: { top: 100, bottom: 100, left: 140, right: 140 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: h, bold: true, font: 'Arial', size: 19, color: 'FFFFFF' })],
                spacing: { after: 40 }
              })
            ]
          });
        })
      })
    );

    // Data Rows
    rows.forEach((row, rIdx) => {
      const isEven = rIdx % 2 === 1;
      tableRows.push(
        new TableRow({
          children: row.map((cellText, idx) => {
            const widthVal = colWidthPercentages ? colWidthPercentages[idx] : Math.floor(100 / headers.length);
            return new TableCell({
              width: { size: widthVal, type: WidthType.PERCENTAGE },
              shading: { fill: isEven ? 'F8FAFC' : 'FFFFFF' },
              margins: { top: 80, bottom: 80, left: 140, right: 140 },
              children: [
                new Paragraph({
                  children: this.parseInlineTokens(cellText),
                  spacing: { after: 40 }
                })
              ]
            });
          })
        })
      );
    });

    this.children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
          left: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
          right: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
          insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' }
        },
        rows: tableRows
      })
    );

    this.children.push(new Paragraph({ spacing: { after: 160 } }));
  }

  public addHorizontalRule(): void {
    this.children.push(
      new Paragraph({
        border: { bottom: { color: 'E2E8F0', size: 6, style: BorderStyle.SINGLE, space: 100 } },
        spacing: { before: 180, after: 200 }
      })
    );
  }

  public async save(outputPath: string): Promise<void> {
    const doc = new Document({
      styles: {
        default: {
          document: {
            run: { font: 'Arial', size: 21, color: '1E293B' }
          },
          heading1: {
            run: { font: 'Arial', size: 32, bold: true, color: '1A73E8' },
            paragraph: { spacing: { before: 360, after: 140 } }
          },
          heading2: {
            run: { font: 'Arial', size: 26, bold: true, color: '0F172A' },
            paragraph: { spacing: { before: 280, after: 100 } }
          },
          heading3: {
            run: { font: 'Arial', size: 22, bold: true, color: '334155' },
            paragraph: { spacing: { before: 200, after: 80 } }
          }
        }
      },
      sections: [{
        properties: {
          page: {
            margin: {
              top: 1440,
              bottom: 1440,
              left: 1440,
              right: 1440
            }
          }
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: this.docTitle, color: '94A3B8', font: 'Arial', size: 16 })
                ]
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: 'Gemini Enterprise Migration Platform  •  Page ', color: '94A3B8', font: 'Arial', size: 16 }),
                  new TextRun({ children: [PageNumber.CURRENT], color: '94A3B8', font: 'Arial', size: 16 }),
                  new TextRun({ text: ' of ', color: '94A3B8', font: 'Arial', size: 16 }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], color: '94A3B8', font: 'Arial', size: 16 })
                ]
              })
            ]
          })
        },
        children: this.children
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);
    console.log(`[SUCCESS] Generated Word Document: ${outputPath} (${buffer.length} bytes)`);
  }

  private parseInlineTokens(text: string): TextRun[] {
    const runs: TextRun[] = [];
    if (!text) return runs;

    const tokenRegex = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[0-9]+\]|\[[^\]]+\])/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        runs.push(new TextRun({
          text: text.substring(lastIndex, match.index),
          font: 'Arial',
          size: 21,
          color: '1E293B'
        }));
      }

      const token = match[0];
      if (token.startsWith('***') && token.endsWith('***')) {
        runs.push(new TextRun({
          text: token.slice(3, -3),
          bold: true,
          italics: true,
          font: 'Arial',
          size: 21,
          color: '0F172A'
        }));
      } else if (token.startsWith('**') && token.endsWith('**')) {
        runs.push(new TextRun({
          text: token.slice(2, -2),
          bold: true,
          font: 'Arial',
          size: 21,
          color: '0F172A'
        }));
      } else if (token.startsWith('*') && token.endsWith('*')) {
        runs.push(new TextRun({
          text: token.slice(1, -1),
          italics: true,
          font: 'Arial',
          size: 21,
          color: '334155'
        }));
      } else if (token.startsWith('`') && token.endsWith('`')) {
        runs.push(new TextRun({
          text: token.slice(1, -1),
          font: 'Consolas',
          size: 19,
          shading: { fill: 'F1F5F9' },
          color: '0F172A'
        }));
      } else if (token.startsWith('[') && token.endsWith(']')) {
        runs.push(new TextRun({
          text: token,
          font: 'Arial',
          size: 18,
          bold: true,
          color: '1A73E8'
        }));
      }

      lastIndex = tokenRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      runs.push(new TextRun({
        text: text.substring(lastIndex),
        font: 'Arial',
        size: 21,
        color: '1E293B'
      }));
    }

    return runs.length > 0 ? runs : [new TextRun({ text, font: 'Arial', size: 21, color: '1E293B' })];
  }
}

// -----------------------------------------------------------------------------
// 1. GENERATE INSTALLATION & SETUP GUIDE (DOCX)
// -----------------------------------------------------------------------------
export async function buildInstallationGuideDocx(outputPath: string): Promise<void> {
  const b = new DocxGuideBuilder('Gemini Enterprise Migration - Installation Guide');

  b.addCoverHeader(
    'Gemini Enterprise Admin Migration Platform',
    'Installation, Environment Setup & Pre-Requisites Technical Guide',
    {
      'Document Version': 'v1.5.5 (Enterprise Release)',
      'Classification': 'Google Cloud Enterprise / Administrative',
      'Target Platform': 'Google Cloud Discovery Engine & Gemini Enterprise',
      'Execution Profile': 'Headless CLI & Local Workstation Web Console (127.0.0.1:8080)',
      'Auth Protocols': 'Google Workspace DWD (OAuth2) & Microsoft Entra ID WiF (STS)'
    }
  );

  // Section 1
  b.addHeading1('1. Overview & Security Architecture');
  b.addParagraph(
    'The **Gemini Enterprise Admin Migration Platform** (`gemini-migrate`) is a purpose-built, high-throughput enterprise migration solution designed to transfer Gemini Enterprise and Google Cloud Discovery Engine assets across Google Cloud projects, geographic regions, and Identity Providers on behalf of enterprise end users.'
  );
  b.addParagraph(
    'The platform migrates **Research Notebooks**, **Granular Grounding Sources** (PDFs, Web URLs, YouTube videos, Google Drive docs), **Custom Agents** (Low-Code and Workflow agents), **User-Created Skills in Agent Registry**, **Multi-Turn Chat History**, **User Personalized Memories & Facts**, and **Studio Artifacts** (Presentations, Infographics, Videos, Interactive Quizzes, and Flashcards).'
  );

  b.addCallout({
    title: 'Workstation-Local Security Isolation Model',
    type: 'important',
    text: 'To satisfy strict enterprise security and InfoSec audit requirements, the migration tool operates entirely within the administrator workstation boundary. No user data, prompt history, or private keys are transmitted to any third-party SaaS servers. All network calls are strictly restricted to official Google Cloud APIs.'
  });

  b.addBullet('**Localhost-Only Network Binding**: The Web Console binds exclusively to `127.0.0.1` (`localhost`), eliminating exposure to external network interfaces.');
  b.addBullet('**SSRF Allowlist Protection**: Outbound requests from the proxy layer are cryptographically constrained to official Google API hostnames (`discoveryengine.googleapis.com`, `agentregistry.googleapis.com`, `gmail.googleapis.com`, `sts.googleapis.com`, `secretmanager.googleapis.com`).');
  b.addBullet('**Private Key Isolation**: Service Account private keys (`sa-dwd-key.json`) and RSA keys (`wif-migration-key.pem`) remain securely on local disk and are never sent over the wire.');
  b.addBullet('**Header-Only Token Injection**: Authentication credentials are transmitted strictly within HTTP `Authorization: Bearer` headers, preventing URL logging in intermediate proxies.');

  b.addImage(
    'docs/images/12_console_main.png',
    'Figure 1.1: Local Administration Console running on Workstation (http://127.0.0.1:8080)',
    560,
    350
  );

  // Section 2
  b.addHeading1('2. System & Workstation Prerequisites');
  b.addParagraph(
    'Before deploying the migration tool, verify that the administrator workstation satisfies the minimum software dependencies:'
  );

  b.addTable(
    ['Component', 'Minimum Version', 'Recommended Version', 'Purpose / Description'],
    [
      ['Node.js', 'v20.0.0 (LTS)', 'v22.x or v20.18+ (LTS)', 'Asynchronous runtime executing CLI pipeline and local Express server'],
      ['npm', 'v10.0.0', 'v10.8+', 'Package manager for installing dependencies'],
      ['Google Cloud SDK', 'v480.0.0', 'Latest (`gcloud components update`)', 'CLI used for GCP authentication, IAM role binding, and ADC'],
      ['Operating System', 'Linux / macOS / Windows WSL2', 'Ubuntu 22.04 LTS / Debian 12 / macOS Sonoma', 'Host platform supported across Linux, macOS, and WSL2'],
      ['ffmpeg (Optional)', 'v4.4+', 'v6.0+ (`apt install ffmpeg`)', 'Enables automated compression of high-bitrate Explainer Videos (> 12 MB)']
    ],
    [20, 20, 25, 35]
  );

  b.addParagraph('Verify your local workstation installation using the following terminal commands:');
  b.addCodeBlock(`node --version     # Expected: v20.0.0 or higher
npm --version      # Expected: v10.0.0 or higher
gcloud --version   # Expected: Google Cloud SDK 480.0.0 or higher
ffmpeg -version    # Optional: Verifies video compression availability`);

  // Section 3
  b.addHeading1('3. Google Cloud Project Pre-Requisites & API Enablement');
  b.addParagraph(
    'The migration platform interacts with Google Cloud Discovery Engine, Identity and Access Management, Google Agent Registry, and Gmail APIs. You must enable the following APIs in both the **Source GCP Project** and the **Target GCP Project** prior to migration.'
  );

  b.addTable(
    ['API Service Name', 'Endpoint Identifier', 'Required On', 'Functional Purpose'],
    [
      ['Discovery Engine API', 'discoveryengine.googleapis.com', 'Source & Target', 'Read/write access to engines, collections, notebooks, custom agents, and sessions'],
      ['Agent Registry API', 'agentregistry.googleapis.com', 'Source & Target', 'Discovers and migrates enterprise skills created by end users'],
      ['Service Usage API', 'serviceusage.googleapis.com', 'Source & Target', 'Verifies consumer project quotas and passes infrastructure pre-flight checks'],
      ['IAM Service Account API', 'iam.googleapis.com', 'Target Project', 'Required for Service Account token minting and DWD impersonation'],
      ['Security Token Service', 'sts.googleapis.com', 'Source & Target', 'Required for Workforce Identity Federation (WiF) OIDC token exchanges'],
      ['Gmail API (Optional)', 'gmail.googleapis.com', 'Target Project', 'Required for dispatching user handover notification emails with attached study guides'],
      ['Secret Manager API', 'secretmanager.googleapis.com', 'Target Project', 'Optional for secure enterprise storage of Service Account keys']
    ],
    [25, 30, 20, 25]
  );

  b.addParagraph('Run the following `gcloud` command to enable the APIs on both environments:');
  b.addCodeBlock(`# Enable APIs on Source Project
gcloud services enable discoveryengine.googleapis.com \\
                       agentregistry.googleapis.com \\
                       serviceusage.googleapis.com \\
                       sts.googleapis.com \\
                       --project=<SOURCE_PROJECT_ID>

# Enable APIs on Target Project
gcloud services enable discoveryengine.googleapis.com \\
                       agentregistry.googleapis.com \\
                       serviceusage.googleapis.com \\
                       iam.googleapis.com \\
                       sts.googleapis.com \\
                       gmail.googleapis.com \\
                       secretmanager.googleapis.com \\
                       --project=<TARGET_PROJECT_ID>`);

  // Section 4
  b.addHeading1('4. IAM Roles & Security Permissions Matrix');
  b.addParagraph(
    'The migration administrator or execution identity requires distinct read and write privileges across the source and target environments to uphold the principle of least privilege.'
  );

  b.addTable(
    ['Environment', 'Role Name / Identifier', 'Role Type', 'Justification / Purpose'],
    [
      ['Source Project', 'roles/discoveryengine.viewer', 'Predefined Role', 'Read-only discovery of custom agents, notebooks, datastores, and chat turns'],
      ['Source Project', 'roles/serviceusage.serviceUsageConsumer', 'Predefined Role', 'Authorizes Discovery Engine API consumption checks on source project'],
      ['Source Project', 'roles/iam.securityReviewer', 'Predefined Role', 'Allows enumerating project IAM bindings (resourcemanager.projects.getIamPolicy) during User Discovery'],
      ['Target Project', 'roles/discoveryengine.admin', 'Predefined Role', 'Creation and configuration of target engines, datastores, agents, and notebooks'],
      ['Target Project', 'roles/iam.serviceAccountTokenCreator', 'Predefined Role', 'Allows minting user-scoped impersonation tokens via Domain-Wide Delegation'],
      ['Target Project', 'roles/serviceusage.serviceUsageConsumer', 'Predefined Role', 'Authorizes Discovery Engine API consumption checks on target project']
    ],
    [20, 35, 20, 25]
  );

  b.addCallout({
    title: 'Resolution of 403 serviceusage.serviceUsageConsumer Errors',
    type: 'tip',
    text: 'Granting `roles/serviceusage.serviceUsageConsumer` and `roles/iam.securityReviewer` on the Source Project is mandatory. Administrative pre-flight checks and project IAM discovery are isolated to the configured Service Account key, ensuring that user-scoped WiF tokens are never erroneously used for administrative engine validation.'
  });

  // Section 4.1
  b.addHeading1('4.1 Google Cloud Organization Policies & Security Constraints');
  b.addParagraph(
    'Enterprise Google Cloud landing zones frequently enforce organizational constraints at the Organization or Folder hierarchy level. Before provisioning credentials, evaluate the following policies:'
  );

  b.addTable(
    ['Organization Policy Constraint', 'Target Requirement', 'Impact on Migration Tool', 'Remediation / Alternative'],
    [
      ['constraints/iam.disableServiceAccountKeyCreation', 'Key creation permitted on target project', 'Blocks Pattern A Step 3: Prevents generating sa-dwd-key.json', 'Use 1-Click project override in Auth Wizard, or adopt Pattern B (WiF) which is keyless and exempt.'],
      ['constraints/iam.disableCrossProjectServiceAccountUsage', 'Target SA created within target project', 'Blocks Cross-Project DWD: A service account from source project cannot access target Discovery Engine', 'Create and bind gemini-dwd-migrator directly within the Target GCP Project.'],
      ['constraints/iam.allowedPolicyMemberDomains', 'Workforce & user domains allowed in IAM', 'Restricts Cross-Domain Sharing: Agent/Skill IAM sync fails if users belong to unauthorized domains', 'Map source identities to target domain via identityMapping, or verify workforce pool principalSet is permitted.'],
      ['constraints/discoveryengine.managed.allowedDataSources', 'Connectors permitted', 'Restricts data store attachment', 'Ensure required data sources (e.g. custom_mcp, Drive, GCS) are permitted by policy.'],
      ['constraints/storage.uniformBucketLevelAccess', 'Uniform bucket-level access', 'Enforces bucket IAM over object ACLs', 'The migration tool defaults to standard IAM bucket permissions; avoid object-level ACLs.']
    ],
    [30, 20, 25, 25]
  );

  b.addHeading2('Live Organization Policy Inspection & 1-Click Remediation');
  b.addParagraph(
    'The web console provides built-in pre-flight inspection in the Auth & WiF Wizard (http://127.0.0.1:8080):'
  );
  b.addNumbered('Navigate to Auth & WiF Wizard -> Domain-Wide Delegation (DWD).', 1);
  b.addNumbered('Enter your Target GCP Project ID and click Check Org Policies.', 2);
  b.addNumbered('If iam.disableServiceAccountKeyCreation is active, click 1-Click Project Override to apply a project-scoped exemption without altering the parent organization.', 3);

  // Section 5
  b.addHeading1('5. Authentication Setup & Credential Provisioning');
  b.addParagraph(
    'The migration tool supports three flexible enterprise authentication patterns depending on the Identity Providers in use:'
  );

  b.addHeading2('Pattern A: Google Workspace / Cloud Identity via Domain-Wide Delegation (DWD)');
  b.addParagraph(
    'Domain-Wide Delegation (DWD) enables the migration tool to restore chat history and personal research notebooks directly into each user\'s personal Google Workspace library.'
  );

  b.addNumbered('Create the migration service account in the Target GCP Project:', 1);
  b.addCodeBlock(`gcloud iam service-accounts create gemini-dwd-migrator \\
    --display-name="Gemini Enterprise Migration Service Account" \\
    --project=<TARGET_PROJECT_ID>`);

  b.addNumbered('Assign required IAM roles to the service account across BOTH Target and Source Projects:', 2);
  b.addCodeBlock(`# Grant roles on TARGET Project (Restore & Token Minting)
gcloud projects add-iam-policy-binding <TARGET_PROJECT_ID> \\
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \\
    --role="roles/discoveryengine.admin"

gcloud projects add-iam-policy-binding <TARGET_PROJECT_ID> \\
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \\
    --role="roles/iam.serviceAccountTokenCreator"

gcloud projects add-iam-policy-binding <TARGET_PROJECT_ID> \\
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \\
    --role="roles/serviceusage.serviceUsageConsumer"

# Grant roles on SOURCE Project (MANDATORY for Cross-Project Discovery & Parity Audit)
gcloud projects add-iam-policy-binding <SOURCE_PROJECT_ID> \\
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \\
    --role="roles/discoveryengine.admin"

gcloud projects add-iam-policy-binding <SOURCE_PROJECT_ID> \\
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \\
    --role="roles/serviceusage.serviceUsageConsumer"

gcloud projects add-iam-policy-binding <SOURCE_PROJECT_ID> \\
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \\
    --role="roles/iam.securityReviewer"`);

  b.addNumbered('Export the service account JSON private key:', 3);
  b.addCodeBlock(`gcloud iam service-accounts keys create sa-dwd-key.json \\
    --iam-account="gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com"`);

  b.addCallout({
    title: 'Blocked by iam.disableServiceAccountKeyCreation?',
    type: 'important',
    text: 'If step 3 returns FAILED_PRECONDITION: Key creation is disabled by organization policy, you can: (1) In the web console Auth Wizard, click 1-Click Project Override (requires roles/orgpolicy.policyAdmin), or apply via gcloud org-policies set-policy; or (2) Switch to Pattern B (Workforce Identity Federation), which exchanges tokens with GCP STS dynamically and is 100% exempt from service account key policies.'
  });

  b.addNumbered('Authorize the Client ID in Google Workspace Admin Console (`admin.google.com`):', 4);
  b.addBullet('Sign in to **admin.google.com** as a Super Administrator.');
  b.addBullet('Navigate to **Security** &rarr; **Access and data control** &rarr; **API controls**.');
  b.addBullet('Under **Domain-wide delegation**, click **Manage Domain Wide Delegation** &rarr; **Add new**.');
  b.addBullet('Enter the **OAuth2 Client ID** of your service account (found in `sa-dwd-key.json` as `client_id`).');
  b.addBullet('In the **OAuth Scopes** field, paste the exact comma-delimited scope string:');
  b.addCodeBlock(`https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/discoveryengine,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/userinfo.email`);
  b.addBullet('Click **Authorize**.');

  b.addHeading2('Pattern B: Microsoft Entra ID / Okta via Workforce Identity Federation (WiF)');
  b.addParagraph(
    'For organizations authenticating via external Identity Providers (Microsoft Entra ID, Okta, Ping Identity), the platform uses Google Cloud Workforce Identity Federation and Security Token Service (STS).'
  );
  b.addNumbered('Place your Workforce Identity Federation pool configuration in `workforce-identity-config.json`.', 1);
  b.addNumbered('Provide RSA signing keys (`wif-migration-key.pem` and `wif-migration-jwks.json`) to sign user subject token assertions.', 2);
  b.addNumbered('When migrating from Entra ID to Google Cloud Identity, the tool mints WiF STS tokens for source discovery and switches to DWD tokens for target restoration.', 3);

  b.addCallout({
    title: 'Keyless Architecture & Organization Policy Immunity',
    type: 'tip',
    text: 'Workforce Identity Federation does not require Service Account keys (sa-dwd-key.json). STS token exchanges are entirely immune to iam.disableServiceAccountKeyCreation and iam.disableServiceAccountKeyUpload organization policies.'
  });

  b.addImage(
    'docs/images/13_auth_wif_wizard.png',
    'Figure 1.2: Interactive Authentication & Workforce Identity Federation (WiF) Setup Wizard',
    560,
    350
  );

  // Section 6
  b.addHeading1('6. Installation, Local Build & Configuration');
  b.addParagraph('Follow these steps to clone, build, and configure the platform on your administrator workstation:');

  b.addNumbered('Clone the repository:', 1);
  b.addCodeBlock(`git clone https://github.com/your-org/gemini-enterprise-admin-migration-tool.git
cd gemini-enterprise-admin-migration-tool`);

  b.addNumbered('Install Node.js dependencies:', 2);
  b.addCodeBlock(`npm install`);

  b.addNumbered('Compile TypeScript to JavaScript production artifacts:', 3);
  b.addCodeBlock(`npm run build`);

  b.addNumbered('Configure `migration-config.json`:', 4);
  b.addParagraph(
    'Copy `config.example.json` to `migration-config.json` and customize your source and target environments:'
  );
  b.addCodeBlock(`{
  "source": {
    "projectId": "source-gcp-project",
    "appLocation": "global",
    "collectionId": "default_collection",
    "appId": "gemini-source-app",
    "assistantId": "default_assistant"
  },
  "target": {
    "projectId": "target-gcp-project",
    "appLocation": "global",
    "collectionId": "default_collection",
    "appId": "gemini-target-app",
    "assistantId": "default_assistant"
  },
  "options": {
    "dryRun": false,
    "migrateNotebooks": true,
    "migrateAgents": true,
    "migrateSkills": true,
    "migrateSessions": true,
    "migrateMemories": true,
    "exportArtifacts": true,
    "userFilter": ["*@company.com"]
  },
  "auth": {
    "authType": "SERVICE_ACCOUNT_KEY",
    "serviceAccountKeyPath": "./sa-dwd-key.json"
  }
}`);

  // Section 7
  b.addHeading1('7. Launching & Validating the Console');
  b.addParagraph(
    'You can run the migration platform either via the interactive Web Console or directly as a headless CLI script:'
  );

  b.addHeading2('Option 1: Launch Local Web Console');
  b.addCodeBlock(`npm start
# Console listens on: http://127.0.0.1:8080`);
  b.addParagraph('Open your web browser and navigate to `http://127.0.0.1:8080`. Verify that the status pill in the top-right reads **API Service Online**.');

  b.addHeading2('Option 2: Headless CLI Execution');
  b.addCodeBlock(`# Run full migration in dry-run simulation mode
npx tsx src/cli.ts --config migration-config.json --dry-run

# Run full live migration
npx tsx src/cli.ts --config migration-config.json`);

  b.addHeading2('Option 3: Run Automated Test Suite');
  b.addCodeBlock(`npm test
# Executes 106 automated tests across 14 test suites covering auth, cross-project parity pre-checks, export, decommissioning, and rollback validation`);

  b.addHeading2('Command-Line CLI Flag Reference');
  b.addTable(
    ['Flag', 'Argument', 'Description', 'Default'],
    [
      ['-c, --config', '<path>', 'Path to JSON migration configuration file', 'migration-config.json'],
      ['--dry-run', '—', 'Simulate migration without applying changes to target', 'false'],
      ['--no-notebooks', '—', 'Skip notebook and source migration', 'Enabled'],
      ['--no-agents', '—', 'Skip custom agent migration', 'Enabled'],
      ['--no-sessions', '—', 'Skip chat conversation history migration', 'Enabled'],
      ['--no-memories', '—', 'Skip personalized memories and facts migration', 'Enabled'],
      ['--no-skills', '—', 'Skip Agent Registry custom skills migration', 'Enabled'],
      ['--export-memories', '—', 'Export JSON snapshot of user memories to local disk', 'false'],
      ['--export-artifacts', '—', 'Export studio presentations, quizzes, and flashcards', 'false'],
      ['--agent-types', '<types...>', 'Filter agent migration by type (LOW_CODE, WORKFLOW, ALL)', 'ALL'],
      ['--publish-agents', '—', 'Auto-publish migrated agents to organizational gallery', 'false'],
      ['--no-preserve-sharing', '—', 'Do not replicate sharing configurations (ALL_USERS/RESTRICTED)', 'Replicate'],
      ['--users', '<users...>', 'Filter migration to specific user email(s) or patterns', 'All users'],
      ['--concurrency', '<number>', 'Maximum parallel worker concurrency', '10'],
      ['--token', '<token>', 'Explicit Google OAuth Access Token (overrides ADC)', '—'],
      ['--service-account-key', '<path>', 'Path to GCP Service Account JSON key for DWD', '—'],
      ['--output-dir', '<dir>', 'Directory to output migration reports', './reports'],
      ['--resume', '<reportPath>', 'Resume migration by skipping already-successful assets', '—'],
      ['--generate-user-reports', '—', 'Generate post-migration handover bundles and checklists', 'false'],
      ['--notify-users', '[override]', 'Dispatch bulk handover emails to users (or test override)', '—'],
      ['--no-zip-attachments', '—', 'Disable packaging user artifacts into .zip archive', 'ZIP enabled'],
      ['--no-optimize-media', '—', 'Disable automatic media optimization for slide decks', 'Optimized']
    ],
    [25, 15, 45, 15]
  );

  // Section 8
  b.addHeading1('8. Troubleshooting & Common Installation Gotchas');
  b.addTable(
    ['Symptom / Error Message', 'Root Cause', 'Actionable Resolution'],
    [
      [
        '403 Forbidden: Caller does not have required permission to use project',
        'Service Usage API is disabled or caller lacks `roles/serviceusage.serviceUsageConsumer`',
        'Run `gcloud services enable serviceusage.googleapis.com --project=<PROJECT_ID>` and grant `roles/serviceusage.serviceUsageConsumer` to caller.'
      ],
      [
        'invalid_grant: Invalid email or User ID',
        'DWD impersonation targeted a user email that does not exist in Google Workspace directory',
        'Verify target user exists in Google Workspace Admin Console (`admin.google.com`) and DWD scopes are authorized.'
      ],
      [
        'ENOENT: idp-subject-token.jwt does not exist',
        'WiF auth selected but subject token file has not been minted or has expired',
        'Generate a fresh subject token using `wif-migration-key.pem` or switch auth type to ADC / DWD.'
      ],
      [
        'EADDRINUSE: address already in use :::8080',
        'Another process is already bound to port 8080 on the workstation',
        'Launch with custom port: `PORT=8085 npm start` or terminate the conflicting process (`lsof -i :8080`).'
      ],
      [
        'Puppeteer / Chrome launch failed',
        'Missing Chrome executable on Linux workstation',
        'Install Google Chrome: `apt-get install -y google-chrome-stable` or use pre-captured artifact assets.'
      ]
    ],
    [30, 30, 40]
  );

  // Section 9
  b.addHeading1('9. Application Decommissioning & Cleanup (Full Teardown)');
  b.addParagraph(
    'When migration waves are completed or during environment reset, the tool provides two distinct cleanup mechanisms in Tab 6 (Target Maintenance & Platform Decommission):'
  );

  b.addHeading2('Button 1: Reset Target Project Assets (Test Iterations)');
  b.addParagraph(
    'Resets migrated assets (notebooks, custom agents, chat history, user memories, reports, and local artifacts) between test iterations without modifying credentials or GCP IAM roles.'
  );

  b.addHeading2('Button 2: Clean Up Install & Decommission Migration App (Full Teardown)');
  b.addParagraph(
    'Completely uninstalls the migration application and restores both Google Cloud and your local workstation to their pre-setup baseline state:'
  );
  b.addBullet('Reset Overwritten Org Policies: Resets iam.disableServiceAccountKeyCreation back to inherit from parent organization via gcloud org-policies reset.');
  b.addBullet('Revoke IAM Roles: Strips roles/discoveryengine.admin, roles/serviceusage.serviceUsageConsumer, and roles/iam.serviceAccountTokenCreator.');
  b.addBullet('Delete Service Account: Deletes gemini-dwd-migrator in Google Cloud IAM.');
  b.addBullet('Invalidate DWD: Permanently revokes token creation in Google Cloud IAM; manual console deletion in admin.google.com required due to Google Workspace API boundaries.');
  b.addBullet('Delete Local Credentials: Removes sa-dwd-key.json, workforce-identity-config.json, *.pem, *.jwt, and migration-config.json.');
  b.addBullet('Purge Output Directories: Empties reports/, exports/, and user_handover_reports/.');
  b.addBullet('Headless CLI Support: Supports "gemini-migrate decommission --project <ID> --confirm <ID> [--wipe-target-assets]".');

  b.addHeading2('Automated Rollback State Verification Engine');
  b.addParagraph(
    'Provides an automated 7-dimension audit engine verifying that organization policies inherit parent defaults, service accounts are permanently deleted, IAM role bindings are removed, DWD tokens are invalidated, local private keys are deleted, output folders are empty, and state caches are cleared.'
  );
  b.addBullet('Web Console: Click "Verify Rollback State" in Tab 6 (Card 2).');
  b.addBullet('Headless CLI: gemini-migrate verify-rollback --project <TARGET_PROJECT_ID>');
  b.addBullet('REST API: GET /api/maintenance/verify-rollback?targetProject=<PROJECT_ID>');

  await b.save(outputPath);
}

// -----------------------------------------------------------------------------
// 2. GENERATE USER & ADMINISTRATOR GUIDE (DOCX)
// -----------------------------------------------------------------------------
export async function buildUserGuideDocx(outputPath: string): Promise<void> {
  const b = new DocxGuideBuilder('Gemini Enterprise Migration - User & Administrator Guide');

  b.addCoverHeader(
    'Gemini Enterprise Admin Migration Platform',
    'Administrator Operations, Asset Restoration, Parity Audit & User Handover Guide',
    {
      'Document Version': 'v1.5.5 (Enterprise Release)',
      'Classification': 'Google Cloud Enterprise / Administrative',
      'Target Audience': 'Cloud Architects, Migration Operators & IT Administrators',
      'Supported Assets': 'Notebooks, Sources, Custom Agents, Chat Sessions, Memories & Artifacts',
      'Handover Formats': 'Interactive Checklists, Single-ZIP Archives, Office PPTX/DOCX, Offline HTML5'
    }
  );

  // Section 1
  b.addHeading1('1. Overview & Key Capabilities');
  b.addParagraph(
    'The **Gemini Enterprise Admin Migration Platform** empowers Google Cloud administrators to execute frictionless, zero-data-loss migrations of Gemini Enterprise and Google Cloud Discovery Engine assets between environments.'
  );

  b.addBullet('**Research Notebooks & Granular Grounding Sources**: Deep-clones notebooks and re-indexes all grounding sources (PDFs, URLs, YouTube videos, Google Drive docs, and text files) with individual integrity auditing.');
  b.addBullet('**Custom Agents & Tool Attachments**: Migrates Low-Code and Workflow agents, preserving system prompts, descriptions, author tags, and grounding DataStore connections as native editable drafts.');
  b.addBullet('**User-Created Skills in Agent Registry**: Migrates custom skills from `agentregistry.googleapis.com` while intelligently ignoring built-in 1P Google templates.');
  b.addBullet('**Multi-Turn Chat History**: Rehydrates conversational histories turn-by-turn into each user\'s left-hand Gemini Enterprise History sidebar.');
  b.addBullet('**Personalized AI Memories & Facts**: Discovers and exports user preferences, role profiles, and learned memory facts.');
  b.addBullet('**Studio Artifacts Export (PPTX, DOCX, Video, Interactive Apps)**: Converts generated presentations into native widescreen PowerPoint (`.pptx`) decks, briefing docs into formatted Microsoft Word (`.docx`) files, explainer videos with automated `ffmpeg` compression, and quizzes/flashcards into 100% offline interactive HTML5 applications.');
  b.addBullet('**Automated User Handover Delivery Engine**: Dispatches personalized email notifications with interactive onboarding checklists (`/checklist`) and a consolidated `NotebookLM_Artifacts.zip` archive.');

  // Section 2
  b.addHeading1('2. Pre-Migration Parity Audit & Gap Remediation (Step 2)');
  b.addParagraph(
    'Before executing a migration run, administrators execute a Configuration Pre-Check in **Step 2: Config & Parity Audit** (`#audit`) to ensure that the target environment has all required feature toggles, security settings, and DataStores configured to support the migrated assets.'
  );

  b.addCallout({
    title: 'Why Configuration Parity Matters',
    type: 'warning',
    text: 'Migrating custom agents or notebooks that reference missing DataStores or disabled platform features (such as user memories or skill sharing) can cause silent runtime errors for end users. The Parity Audit catches these gaps beforehand.'
  });

  b.addHeading2('Interactive Step 2 Environment Selector & Bi-Directional Sync');
  b.addBullet('**Direct Environment Configuration**: Step 2 features interactive Source and Target environment cards allowing administrators to configure Source Project ID, Region, Collection, and Engine/App ID as well as Target Project ID, Region, Collection, and Engine/App ID directly.');
  b.addBullet('**Real-Time Bi-Directional Synchronization**: Any configuration changed in Step 2 automatically synchronizes to Step 3 (Migration Studio), and vice-versa.');
  b.addBullet('**Guided Empty-State Guardrail**: Prevents premature API calls when project IDs are unconfigured, guiding the operator with actionable instructions.');
  b.addBullet('**Parity Readiness Score (0–100%)**: Analyzes more than 100 configuration points across engine feature flags and attached DataStores.');
  b.addBullet('**Wizard Progression**: Click **Next: Proceed to Step 3: Migration Studio** at the bottom of the audit report to carry configured environments forward.');

  b.addImage(
    'docs/images/03_config_precheck_gaps.png',
    'Figure 2.1: Configuration Pre-Check & Gap Audit Screen with Parity Readiness Score',
    560,
    350
  );

  b.addHeading2('Actionable Gap Remediation Plan');
  b.addParagraph(
    'For any detected discrepancies, the console offers a **1-Click Sync Target Engine Settings** button (`PATCH` API) and generates ready-to-run Google Cloud CLI commands. Administrators can copy these commands with a single click and execute them in Cloud Shell or a terminal.'
  );

  b.addImage(
    'docs/images/04_gap_remediation_cli.png',
    'Figure 2.2: Actionable Gap Remediation Plan with 1-Click Copyable CLI Commands',
    560,
    350
  );

  // Section 3
  b.addHeading1('3. Migration Pipeline Configuration (Step 3: Migration Studio)');
  b.addParagraph(
    'On the **Migration Studio** (`#studio`) tab, review or adjust the synchronized Source and Target environment parameters:'
  );

  b.addBullet('**Source Project ID**: The GCP project hosting current Gemini Enterprise assets (e.g. `ancient-sandbox-322523`).');
  b.addBullet('**Source Region**: Geographic location (`global`, `eu`, `us-central1`).');
  b.addBullet('**Source Engine / App ID**: Dropdown auto-populated with discovered engines.');
  b.addBullet('**Source Identity Provider**: Select between `Google Workspace / Cloud Identity (DWD)` or `Microsoft Entra ID (Workforce Identity Federation)`.');
  b.addBullet('**Target Project ID & Region**: The destination environment (e.g. `testgebackupandrestorev3`).');
  b.addBullet('**Target Identity Provider**: Destination authentication provider.');

  b.addImage(
    'docs/images/01_pipeline_configuration.png',
    'Figure 2.3: Migration Pipeline Configuration in Web Console',
    560,
    350
  );

  // Section 4
  b.addHeading1('4. Scoping & Asset Selection');
  b.addParagraph(
    'Administrators can selectively include or exclude specific asset categories to tailor the migration scope:'
  );

  b.addTable(
    ['Scope Checkbox', 'Asset Category', 'Default State', 'Operational Effect'],
    [
      ['Migrate Notebooks & Sources', 'Research Notebooks & Grounding Docs', 'Enabled (Checked)', 'Restores notebooks and re-indexes all attached PDFs, URLs, and YouTube videos'],
      ['Migrate Custom Agents', 'Low-Code & Workflow Agents', 'Enabled (Checked)', 'Deep-copies agent instructions, tools, and datastores as native editable drafts'],
      ['Migrate User Skills', 'User-Created Skills in Agent Registry', 'Enabled (Checked)', 'Migrates custom skills in agentregistry.googleapis.com while ignoring built-in 1P Google templates'],
      ['Migrate Multi-User Chat History', 'Chat Conversation History', 'Enabled (Checked)', 'Rehydrates chronological chat sessions into the target Gemini sidebar'],
      ['Migrate User Memories & Facts', 'Personalized Facts & Profiles', 'Enabled (Checked)', 'Discovers and exports memory facts to local JSON backup and target library'],
      ['Export & Archive User Artifacts', 'Studio Outputs & Presentations', 'Enabled (Checked)', 'Generates `.pptx` decks, `.docx` study guides, `.html` apps, and `.mp4` videos'],
      ['Dry Run (Simulate Only)', 'Safety Simulation Mode', 'Disabled (Unchecked)', 'When checked, performs full discovery and logging without writing to target']
    ],
    [25, 25, 20, 30]
  );

  // Section 5
  b.addHeading1('5. Targeted User Selection & Cross-IdP Transformation Rules');
  b.addParagraph(
    'In enterprise migrations, you may want to migrate a pilot group of VIP users before rolling out to the entire organization. The platform provides granular user discovery and selection controls.'
  );

  b.addNumbered('Click **Discover App Users**: The tool scans source DataStores and agents to discover all active user emails.', 1);
  b.addNumbered('Select Specific Users: Check or uncheck individual users in the table.', 2);
  b.addNumbered('Configure Cross-IdP Domain Mapping: When migrating between different IdPs (e.g. Microsoft Entra ID to Google Cloud Identity), configure the transformation rules:', 3);

  b.addCallout({
    title: 'Cross-IdP Domain Translation Rules',
    type: 'tip',
    text: 'When moving from Entra ID (`user@tenant.onmicrosoft.com`) to Google Cloud Identity (`user@company.com`), the tool automatically strips the source suffix and appends the target domain, completely preventing duplicate domain concatenation bugs.'
  });

  b.addImage(
    'docs/images/02_user_discovery_and_cross_idp.png',
    'Figure 2.4: Targeted User Discovery and Cross-IdP Transformation Matrix',
    560,
    350
  );

  // Section 6
  b.addHeading1('6. Executing the Migration Pipeline');
  b.addParagraph(
    'Once configured, click **🚀 Execute Live Migration** (or **⚡ Execute Pre-Flight Dry Run**). The migration pipeline executes across 7 discrete stages:'
  );

  b.addNumbered('Stage 1: Pre-Flight Infrastructure Checks — Verifies target engine existence, accessibility, and service usage quotas.', 1);
  b.addNumbered('Stage 2: Notebooks & Granular Sources Restoration — Syncs research notebooks and restores individual grounding documents.', 2);
  b.addNumbered('Stage 3: User Skills Discovery & Restoration — Migrates custom skills in `agentregistry.googleapis.com`.', 3);
  b.addNumbered('Stage 4: Custom Agents Restoration — Creates target agents as editable drafts with preserved system instructions.', 4);
  b.addNumbered('Stage 5: Multi-Turn Chat Conversation Rehydration — Recreates conversational turns chronologically for each user.', 5);
  b.addNumbered('Stage 6: Personalized AI Memories & Facts Export — Backs up and migrates discovered user facts.', 6);
  b.addNumbered('Stage 7: Studio Artifacts Discovery, Office Generation & Compression — Synthesizes PPTX presentations, Word study guides, interactive HTML5 quiz/flashcard apps, and compresses Explainer Videos.', 7);

  // Section 7
  b.addHeading1('7. Migration Reports & Reconciliation Auditing (Step 4)');
  b.addParagraph(
    'Upon pipeline completion, the platform generates comprehensive executive and machine-readable audit reports saved in `reports/`:'
  );
  b.addBullet('**Markdown Report** (`reports/migration-report-<ID>-<TIMESTAMP>.md`): Human-readable executive summary with detailed asset breakdown.');
  b.addBullet('**JSON Report** (`reports/migration-report-<ID>-<TIMESTAMP>.json`): Structured telemetry schema for SIEM or enterprise database logging.');
  b.addBullet('**User Reconciliation Matrix**: Comprehensive table matching each source user identity with their target Google identity, listing restored vs. failed counts across all asset categories.');

  b.addImage(
    'docs/images/05_migration_report_reconciliation.png',
    'Figure 2.5: Migration Report and User Reconciliation Matrix in Web Console',
    560,
    350
  );

  // Section 8
  b.addHeading1('8. User Handover Delivery & Notification Engine (Step 5)');
  b.addParagraph(
    'To deliver a seamless day-one onboarding experience, the platform packages each user\'s assets into a single consolidated `NotebookLM_Artifacts.zip` archive and dispatches an onboarding email.'
  );

  b.addBullet('**Action-Oriented Checklists**: The email features interactive checkboxes `[ ]` guiding users through initial sign-in, connector authorizations (Outlook, OneDrive, Google Drive, Jira), and agent publishing, along with explicit warnings if any asset types were skipped.');
  b.addBullet('**Smart Deduplication**: Static HTML document viewers are excluded when authentic Word documents are attached, but interactive quiz and flashcard apps are explicitly preserved alongside Word study guides.');
  b.addBullet('**Multi-Part Email Threading**: If user assets exceed Gmail\'s 14.5 MB unencoded per-message threshold, attachments are automatically bin-packed into sequential parts and delivered within a single threaded conversation (`In-Reply-To`).');

  b.addImage(
    'docs/images/09_gmail_user_handover_delivery.png',
    'Figure 2.6: Migration Handover Notification Received in Gmail with Attachments',
    560,
    350
  );

  b.addImage(
    'docs/images/10_gmail_multipart_thread.png',
    'Figure 2.7: Multi-Part Handover Thread with Partitioned Attachments in Gmail',
    560,
    350
  );

  b.addImage(
    'docs/images/14_user_handover_console.png',
    'Figure 2.8: User Handover & Email Delivery Console Tab',
    560,
    350
  );

  // Section 9
  b.addHeading1('9. Auth & Identity Provider Configuration Wizard (Step 1: DWD & WiF)');
  b.addParagraph(
    'The **Auth & WiF Wizard** (`#wizard`) provides an interactive, guided interface to configure and test authentication protocols across Google Workspace and external Identity Providers (Microsoft Entra ID, Okta, Ping).'
  );

  b.addHeading2('9.1 Domain-Wide Delegation (DWD) & Cross-Project IAM Generator');
  b.addBullet('**Dual Project Topology Input**: Accepts both **Source GCP Project ID** and **Target GCP Project ID** (`wizDwdSrcProject` and `wizDwdProject`), automatically synchronizing with Step 2 and Step 3.');
  b.addBullet('**Cross-Project IAM Command Generator**: Generates copy-paste ready `gcloud` CLI commands granting `roles/discoveryengine.admin` and `roles/serviceusage.serviceUsageConsumer` across **both** Source and Target environments, along with an Architecture Explainer clarifying user impersonation vs administrative pipeline permissions.');
  b.addBullet('**Check Org Policies**: Performs live inspection of target project organization policies (`iam.disableServiceAccountKeyCreation`, `iam.disableCrossProjectServiceAccountUsage`, and `iam.allowedPolicyMemberDomains`).');
  b.addBullet('**Conflict Detection**: If `iam.disableServiceAccountKeyCreation` is active, an alert banner warns the operator before executing CLI commands that creating `sa-dwd-key.json` will fail.');
  b.addBullet('**1-Click Project Override**: Operators holding `roles/orgpolicy.policyAdmin` can click the 1-Click Project Override button to automatically apply a project-scoped exemption (`enforce: false`) without modifying parent organizational policies.');
  b.addBullet('**Live DWD Impersonation Test**: Validates that minted user-scoped OAuth2 tokens function against Discovery Engine APIs.');

  b.addHeading2('9.2 Workforce Identity Federation (WiF) — Keyless Enterprise Path');
  b.addBullet('**Keyless Architecture**: WiF exchanges external OIDC/SAML tokens with Google Cloud Security Token Service (`sts.googleapis.com`) to mint short-lived tokens and is **100% exempt from `iam.disableServiceAccountKeyCreation`** and key upload policies.');
  b.addBullet('**Truthful Live SA Impersonation Verification (`generateAccessToken`)**: When testing WiF impersonation (`/api/wizard/test-wif`), the console performs a live token exchange against the **Google Cloud IAM Credentials API** (`serviceAccounts.generateAccessToken`). If the caller or workforce pool lacks `roles/iam.serviceAccountTokenCreator` on the target service account, the test fails truthfully with actionable error context rather than simulating success.');
  b.addBullet('**Domain Sharing Validation**: Verifies that `iam.allowedPolicyMemberDomains` permits workforce pool principals (`is:principalSet://iam.googleapis.com/organizations/<org-id>`).');
  b.addBullet('**Live GCP Verification**: The Verify Live in GCP button tests workforce pools and OIDC providers directly in Google Cloud.');

  b.addHeading2('9.3 Permissions & Least-Privilege Auditor');
  b.addBullet('Evaluates Discovery Engine read/write scopes, NotebookLM source access, and Gmail API dispatch scopes.');
  b.addBullet('Flags over-provisioned permissions or destructive deletion privileges.');
  b.addBullet('Runs automated organization policy compliance audits on the target project.');
  b.addBullet('Offers 1-click IAM policy bindings auto-fixes for missing roles.');

  b.addImage(
    'docs/images/13_auth_wif_wizard.png',
    'Figure 2.9: Auth & Identity Provider Configuration Wizard with Org Policy Pre-Flight',
    560,
    350
  );

  // Section 10
  b.addHeading1('10. Target Maintenance & Selective Rollback');
  b.addParagraph(
    'The Target Maintenance console provides two distinct operational flows: resetting assets between test iterations, or performing a complete teardown of the migration app:'
  );

  b.addHeading2('Button 1: Reset Target Project Assets (Test Iterations)');
  b.addParagraph(
    'Selectively cleans migrated assets in the target environment prior to fresh migration runs without disturbing authentication or GCP infrastructure:'
  );

  b.addTable(
    ['Maintenance Option', 'Scope of Action', 'Risk Level', 'Recommendation'],
    [
      ['Clean Target Chats', 'Deletes migrated chat sessions for selected users', 'Low', 'Safe to run between test iterations to avoid duplicate session history'],
      ['Clean Target Agents', 'Removes custom agents created by migration pipeline', 'Medium', 'Use when iterating on system prompt translations or tool bindings'],
      ['Clean Target Notebooks', 'Deletes migrated research notebooks in target', 'Medium', 'Use when re-testing source ingestion or PDF uploads'],
      ['Clean User Memories', 'Purges personalized user facts & memory profiles', 'Low', 'Cleans personalization state across all target user scopes'],
      ['Clean Exported Artifacts', 'Clears `exports/artifacts/` folder on local disk', 'Low', 'Frees local disk space without modifying cloud environments'],
      ['Clean Migration Reports', 'Clears `reports/` folder on local disk', 'Low', 'Archives old run logs and handover bundles']
    ],
    [25, 30, 15, 30]
  );

  b.addHeading2('Button 2: Clean Up Install & Decommission Migration App (Full Teardown)');
  b.addParagraph(
    'Performs a complete application uninstall and restores your Google Cloud project and workstation to their pre-setup baseline state:'
  );
  b.addBullet('Reset Overwritten Org Policies: Resets iam.disableServiceAccountKeyCreation back to inherited parent default.');
  b.addBullet('Delete Service Account & Strip IAM Roles: Revokes discoveryengine.admin, serviceUsageConsumer, and deletes the service account.');
  b.addBullet('Invalidate Domain-Wide Delegation (DWD): Permanently revokes token minting in GCP IAM; manual console deletion in admin.google.com required due to Google Workspace API boundaries.');
  b.addBullet('Delete Local Credentials: Removes sa-dwd-key.json, workforce-identity-config.json, *.pem, *.jwt, and migration-config.json.');
  b.addBullet('Purge Local Folders: Empties reports/, exports/, and user_handover_reports/.');
  b.addBullet('Headless CLI Execution: gemini-migrate decommission --project <TARGET_PROJECT_ID> --confirm <TARGET_PROJECT_ID>');

  b.addHeading2('Automated Rollback State Verification Engine');
  b.addParagraph(
    'Audits cloud and local baseline state across 7 security dimensions. Automatically runs after decommissioning or can be triggered on demand via Web Console ("Verify Rollback State"), Headless CLI (gemini-migrate verify-rollback --project <ID>), or REST API.'
  );
  b.addBullet('Web Console: Tab 6 (Card 2) "Verify Rollback State" button with live audit checklist.');
  b.addBullet('Headless CLI: gemini-migrate verify-rollback --project <TARGET_PROJECT_ID>');
  b.addBullet('REST API: GET /api/maintenance/verify-rollback?targetProject=<PROJECT_ID>');

  b.addImage(
    'docs/images/15_target_maintenance.png',
    'Figure 2.11: Target Maintenance & Platform Decommissioning Console',
    560,
    350
  );

  // Section 11
  b.addHeading1('11. Enterprise Migration Playbook & Best Practices');
  b.addParagraph('Follow this recommended four-phase migration playbook for enterprise rollouts:');

  b.addHeading2('Phase 1: Pre-Flight Discovery & Parity Alignment');
  b.addNumbered('Open the Auth & WiF Wizard and run Check Org Policies to verify that target project policies permit credential provisioning or apply 1-click project overrides.', 1);
  b.addNumbered('Run Configuration Pre-Check & Gap Audit against Source and Target engines.', 2);
  b.addNumbered('Execute generated CLI commands to align DataStores and feature flags.', 3);
  b.addNumbered('Confirm that caller identity has `roles/serviceusage.serviceUsageConsumer` on both projects.', 4);

  b.addHeading2('Phase 2: Pilot Wave Execution (5–10 VIP Users)');
  b.addNumbered('Select 5–10 active power users with notebooks and agents.', 5);
  b.addNumbered('Run a Dry Run simulation to verify identity mapping and asset discovery.', 6);
  b.addNumbered('Execute Live Migration and review the resulting Markdown audit report.', 7);
  b.addNumbered('Dispatch pilot handover emails and verify user receipt in Gmail.', 8);

  b.addHeading2('Phase 3: Production Bulk Migration Wave');
  b.addNumbered('Execute migration for remaining organizational users.', 9);
  b.addNumbered('Monitor streaming event logs for any network throttling or quota pauses.', 10);
  b.addNumbered('Verify that 100% of discovered notebooks, sources, and agents migrated successfully.', 11);

  b.addHeading2('Phase 4: Post-Migration Handover & Support');
  b.addNumbered('Dispatch bulk handover email packages with `NotebookLM_Artifacts.zip`.', 12);
  b.addNumbered('Direct users to `/checklist` for guided day-one onboarding steps.', 13);
  b.addNumbered('Archive final migration reports for compliance records.', 14);

  await b.save(outputPath);
}

// -----------------------------------------------------------------------------
// MAIN EXECUTION
// -----------------------------------------------------------------------------
async function main() {
  const docsDir = path.resolve(process.cwd(), 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const installPath = path.join(docsDir, 'INSTALLATION_GUIDE.docx');
  const userPath = path.join(docsDir, 'USER_GUIDE.docx');

  console.log('[INFO] Building Installation Guide DOCX with pictures...');
  await buildInstallationGuideDocx(installPath);

  console.log('[INFO] Building User Guide DOCX with pictures...');
  await buildUserGuideDocx(userPath);

  // Also create root symlinks / copies for immediate user convenience
  fs.copyFileSync(installPath, path.join(process.cwd(), 'INSTALLATION_GUIDE.docx'));
  fs.copyFileSync(userPath, path.join(process.cwd(), 'USER_GUIDE.docx'));
  console.log('[SUCCESS] Root copies created: INSTALLATION_GUIDE.docx and USER_GUIDE.docx');
}

main().catch((err) => {
  console.error('[ERROR] Failed to generate guides:', err);
  process.exit(1);
});
