
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { ExtractedData, ApiFilePart } from "../types";
import { fileToBase64 } from "../utils";

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const SYSTEM_INSTRUCTION = `
You are an expert Fiscal Auditor for the Brazilian Air Force (Comando da Aeronáutica). 
Your task is to analyze a set of uploaded documents and extract specific data points for audit verification.

**IMPORTANT: CROSS-REFERENCE FILENAMES**
I will provide the **File Name** immediately before the content of each document. 
You MUST check if the *Content* of the document matches its *File Name*.
- If a file is named "Informação Administrativa", "Justificativa", "Memo", etc., but the content is a **DANFE** or **Nota Fiscal**, you MUST set \`informacaoAdministrativa.wrongDocumentDetected = true\`.

**DOCUMENTS TO ANALYZE:**

1. **SICAF (Sistema de Cadastro Unificado)**:
   - Identify the "Validade" date for EACH of the following specific certificates:
     - Receita Federal e PGFN
     - FGTS
     - Trabalhista
     - Fiscal Estadual / Distrital
     - Fiscal Municipal
   - Extract the main CNPJ.

2. **Termo de Recebimento (TR)**:
   - Extract the *latest* signature date (Data de assinatura do recebedor/comissão). This is the REFERENCE DATE.
   - Check if the text explicitly says "recebido e aceito definitivamente".
   - Extract the CNPJ.
   - Extract the **Total Value** (Valor Total) formatted as a number.
   - Extract the **Contract Number** (e.g., "102/CELOG...").
   - Extract Contract year if mentioned.

3. **Nota Fiscal (NF)**:
   - Extract the **NF Number** (Número) and **Supplier Name** (Razão Social/Nome do Emitente).
   - **CRITICAL - CNPJ Extraction**: Extract the **ISSUER'S CNPJ** (CNPJ do Emitente). 
     - **DO NOT** extract the Recipient's (Destinatário) CNPJ.
     - **FAILSAFE**: Extract *ALL* CNPJs found anywhere in the invoice document into the 'possibleCnpjs' list.
   - Extract Emission Date.
   - **CRITICAL - VALUES**:
     - **Gross Value (grossValue)**: Extract the "VALOR TOTAL DA NOTA" or "VALOR TOTAL DOS SERVIÇOS". This is the value BEFORE taxes/retentions. It is usually the larger amount.
     - **Liquid Value (liquidValue)**: Extract the "VALOR LÍQUIDO" (if present, usually matches the amount to be paid after retentions).
   - **CRITICAL - TYPE**: Determine if the items listed are **Material/Products** or **Services**.
   - **LINE ITEMS**: Extract a list of all items.

4. **Relatório Fatura**:
   - Extract Emission Date, **Arrival Date** (Data Chegada), and **Due Date** (Data Vencimento).
   - **CRITICAL - VALUES**: 
     - Extract the **"Total Fatura"** value found at the bottom of the item list or summary. This is the actual amount being billed.
   - **CRITICAL - EMPENHOS**: 
     - Extract the Empenho Number (NE) and Natureza de Despesa (ND). 
     - Only extract Empenhos listed **ABOVE** the "Total Fatura" line.
     - Ignore the "Resumo PAG" section.

5. **RMM / Nota de Recebimento**:
   - Check if document exists.
   - **LINE ITEMS**: Extract the list of materials entered into stock.

6. **Informação Administrativa**:
   - **STRICT DOCUMENT TYPE CHECK**: Look for a document explicitly titled "Informação Administrativa", "Memorando", "Parte", or "Nota Explicativa".
   - **NEGATIVE CONSTRAINT**: If the document identified as (or named as) "Informação Administrativa" is actually a **DANFE**, **Nota Fiscal**, or **Invoice** (contains "DANFE", "Chave de Acesso", "Valor Total da Nota"), explicitly SET **wrongDocumentDetected = true**. 
   - If 'wrongDocumentDetected' is true, set 'found' to false (or true, but the error flag takes precedence).
   - If it is a valid Administrative document, check:
     - Does it substitute RMM?
     - Does it justify using a Service ND (339039) for material items?

Return the data in a clean JSON format matching the schema provided. 
`;

// Defined schema constant to avoid duplication between browser and API modes
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    sicaf: {
      type: Type.OBJECT,
      properties: {
        found: { type: Type.BOOLEAN },
        cnpj: { type: Type.STRING, nullable: true },
        validityDates: { 
          type: Type.OBJECT,
          properties: {
            federal_pgfn: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
            fgts: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
            trabalhista: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
            estadual_distrital: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
            municipal: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
          }
        }
      }
    },
    termoRecebimento: {
      type: Type.OBJECT,
      properties: {
        found: { type: Type.BOOLEAN },
        cnpj: { type: Type.STRING, nullable: true },
        signatureDate: { type: Type.STRING, nullable: true, description: "The specific date the commission signed. YYYY-MM-DD" },
        isDefinitive: { type: Type.BOOLEAN },
        bulletinDate: { type: Type.STRING, nullable: true },
        hasContractReference: { type: Type.BOOLEAN },
        contractStartYear: { type: Type.INTEGER, nullable: true },
        totalValue: { type: Type.NUMBER, nullable: true },
        contractNumber: { type: Type.STRING, nullable: true }
      }
    },
    notaFiscal: {
      type: Type.OBJECT,
      properties: {
        found: { type: Type.BOOLEAN },
        number: { type: Type.STRING, nullable: true },
        supplierName: { type: Type.STRING, nullable: true },
        cnpj: { type: Type.STRING, nullable: true },
        possibleCnpjs: { type: Type.ARRAY, items: { type: Type.STRING } },
        emissionDate: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
        grossValue: { type: Type.NUMBER, nullable: true, description: "Valor TOTAL DA NOTA (Bruto)" },
        liquidValue: { type: Type.NUMBER, nullable: true, description: "Valor Líquido (Net)" },
        isMaterial: { type: Type.BOOLEAN },
        isService: { type: Type.BOOLEAN },
        items: {
          type: Type.ARRAY,
          items: {
              type: Type.OBJECT,
              properties: {
                  description: { type: Type.STRING },
                  partNumber: { type: Type.STRING, nullable: true },
                  quantity: { type: Type.NUMBER },
                  unit: { type: Type.STRING, nullable: true }
              }
          }
        }
      }
    },
    relatorioFatura: {
      type: Type.OBJECT,
      properties: {
        found: { type: Type.BOOLEAN },
        emissionDate: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
        arrivalDate: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
        dueDate: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
        totalValue: { type: Type.NUMBER, nullable: true, description: "The explicit 'Total Fatura' amount." },
        empenhos: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              ne: { type: Type.STRING },
              nd: { type: Type.STRING },
              value: { type: Type.NUMBER }
            }
          }
        }
      }
    },
    rmm: {
      type: Type.OBJECT,
      properties: {
        found: { type: Type.BOOLEAN },
        items: {
          type: Type.ARRAY,
          items: {
              type: Type.OBJECT,
              properties: {
                  description: { type: Type.STRING },
                  partNumber: { type: Type.STRING, nullable: true },
                  quantity: { type: Type.NUMBER },
                  unit: { type: Type.STRING, nullable: true }
              }
          }
        }
      }
    },
    informacaoAdministrativa: {
      type: Type.OBJECT,
      properties: {
        found: { type: Type.BOOLEAN },
        justification: { type: Type.STRING, nullable: true },
        substitutesRmm: { type: Type.BOOLEAN },
        justifiesServiceND: { type: Type.BOOLEAN },
        wrongDocumentDetected: { type: Type.BOOLEAN, description: "True if a file named like Info Admin contains a DANFE" }
      }
    }
  }
};

export const analyzeDocuments = async (files: File[]): Promise<ExtractedData> => {
  const model = "gemini-2.5-flash"; 
  
  const parts = [];

  for (const file of files) {
    const base64Data = await fileToBase64(file);
    const mimeType = file.type === 'application/pdf' ? 'application/pdf' : file.type;
    
    // Inject File Name context before the file content
    parts.push({
        text: `*** FILE NAME: "${file.name}" ***\n(Analyze the following document content in the context of this filename)`
    });

    parts.push({
      inlineData: {
        data: base64Data,
        mimeType: mimeType,
      },
    });
  }

  // Add the prompt text
  parts.push({
    text: "Analyze these documents and extract the fiscal data. Be extremely strict about classifying 'Informação Administrativa' - if a file named like an admin document actually contains a Nota Fiscal/DANFE layout, flag it as wrongDocumentDetected."
  });

  const response = await ai.models.generateContent({
    model: model,
    contents: {
      parts: parts
    },
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA
    }
  });

  if (response.text) {
    return JSON.parse(response.text) as ExtractedData;
  } else {
    throw new Error("Failed to extract data from Gemini.");
  }
};

// New function for direct API invocation (bypassing File objects)
export const auditFromApi = async (files: ApiFilePart[]): Promise<ExtractedData> => {
  const model = "gemini-2.5-flash";
  
  const parts = [];

  for (const file of files) {
    // Inject File Name context before the file content (Critical for cross-referencing)
    parts.push({
        text: `*** FILE NAME: "${file.fileName}" ***\n(Analyze the following document content in the context of this filename)`
    });

    // Use provided Base64 directly
    parts.push({
      inlineData: {
        data: file.base64Data,
        mimeType: file.mimeType,
      },
    });
  }

  // Add the prompt text
  parts.push({
    text: "Analyze these documents and extract the fiscal data. Be extremely strict about classifying 'Informação Administrativa' - if a file named like an admin document actually contains a Nota Fiscal/DANFE layout, flag it as wrongDocumentDetected."
  });

  const response = await ai.models.generateContent({
    model: model,
    contents: {
      parts: parts
    },
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA
    }
  });

  if (response.text) {
    return JSON.parse(response.text) as ExtractedData;
  } else {
    throw new Error("Failed to extract data from Gemini.");
  }
};
