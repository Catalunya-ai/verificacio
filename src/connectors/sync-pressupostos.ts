/**
 * Menjometre Budget Transfers Sync Script
 *
 * Fetches budget execution data from SODA API dataset ajns-4mi7
 * ("Execució mensual del pressupost de la Generalitat - Despeses")
 * and loads transfer chapters into your PostgreSQL database (DATABASE_URL) via psql.
 *
 * API: https://analisi.transparenciacatalunya.cat/resource/ajns-4mi7.json
 * Data: ~1.6M records total, filtered to transfer chapters + December = ~5-10K rows
 *
 * Usage: npx tsx src/connectors/sync-pressupostos.ts [--full | --dry-run | --skip-aggregation | --cap8-only]
 */

import { execSync } from "child_process";
import { libpqEnv } from "../lib/db";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ============================================================
// SODA API types
// ============================================================

interface SodaBudgetRecord {
  exercici?: string;
  mes?: string;
  aplicaci?: string;
  posici_pressupost_ria?: string;
  cap_tol?: string;
  cap_tol_codi?: string;
  article_codi?: string;    // "87" for equity contributions
  article?: string;         // "Aportacions de capital a entitats..."
  concepte_codi?: string;   // "870", "871", etc.
  secci?: string;
  secci_codi?: string;
  cr_dits_inicials?: string;
  pressupost_definitiu?: string;
  obligacions_reconegudes?: string;
  entitat?: string;
  entitat_codi?: string;
}

// ============================================================
// Constants
// ============================================================

const SODA_BASE = "https://analisi.transparenciacatalunya.cat/resource/ajns-4mi7.json";
const BATCH_SIZE = 50000;
const SQL_BATCH = 2000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const RATE_LIMIT_MS = 200;

// Transfer chapters to import
const TRANSFER_CHAPTERS = [
  "Transferències corrents",
  "Transferències de capital",
];

// Generic budget lines to SKIP (multi-recipient, cannot attribute to single entity)
const SKIP_PATTERNS = [
  "participació dels ajuntaments",
  "participació de les diputacions",
  "a empreses privades",
  "a famílies",
  "a corporacions locals",
  "concerts educatius",
  "farmàcia",
  "receptes mèdiques",
  "renda garantida",
  "a universitats públiques",
  "nòmina delegada",
  "prestació econòmica per cuidador",
  "prestació econòmica vinculada",
  "als centres especials de treball",
  "a altres institucions sense fi de lucre",
  "a fundacions",
  "beques",
  "a altres ens dependents",
  "a consorcis dependents",
  "a fundacions del sector públic",
  "a ens locals",
  "fons de cooperació local",
  "a empreses públiques",
  "interessos",
  "fons de contingència",
];

// ============================================================
// Top entity mapping: budget_name → entity_slug
// Covers >90% of money volume. Based on 2024 December data.
// ============================================================

const ENTITY_MAPPING = new Map<string, string>([
  // Health
  ["Al Servei Català de la Salut", "SERVEI-CATALA-DE-LA-SALUT"],
  ["A l'Institut Català de la Salut (ICS)", "INSTITUT-CATALA-DE-LA-SALUT"],
  ["A l'Institut Català de la Salut", "INSTITUT-CATALA-DE-LA-SALUT"],
  ["Al Consorci Mar Parc de Salut de Barcelona", "CONSORCI-MAR-PARC-DE-SALUT-DE-BARCELONA"],
  ["A Coordinació Logística Sanitària, AIE", "COORDINACIO-LOGISTICA-SANITARIA-AIE"],

  // Transport
  ["A l'Autoritat del Transport Metropolità, consorci per a la coordinació del sistema metropolità de transport públic de l'àrea de Barcelona", "AUTORITAT-DEL-TRANSPORT-METROPOLITA"],
  ["A Ferrocarrils de la Generalitat de Catalunya", "FERROCARRILS-DE-LA-GENERALITAT-DE-CATALUNYA"],
  ["A Infraestructures Ferroviàries de Catalunya (IFERCAT)", "INFRAESTRUCTURES-FERROVIARIES-DE-CATALUNYA"],

  // Media
  ["A la Corporació Catalana de Mitjans Audiovisuals (CCMA)", "CORP-CAT-DE-MITJANS-AUDIOVISUALS-SA"],

  // Employment
  ["Al Servei Públic d'Ocupació de Catalunya (SOC)", "SERVEI-PUBLIC-D-OCUPACIO-DE-CATALUNYA"],

  // Education - Universities
  ["A la Universitat de Barcelona", "UNIVERSITAT-DE-BARCELONA"],
  ["A la Universitat Autònoma de Barcelona", "UNIVERSITAT-AUTONOMA-DE-BARCELONA"],
  ["A la Universitat Politècnica de Catalunya", "UNIVERSITAT-POLITECNICA-DE-CATALUNYA"],
  ["A la Universitat Rovira i Virgili", "UNIVERSITAT-ROVIRA-I-VIRGILI"],
  ["A la Universitat Pompeu Fabra", "UNIVERSITAT-POMPEU-FABRA"],
  ["A la Universitat de Girona", "UNIVERSITAT-DE-GIRONA"],
  ["A la Universitat de Lleida", "UNIVERSITAT-DE-LLEIDA"],
  ["A la Fundació per a la Universitat Oberta de Catalunya", "FUNDACIO-PER-A-LA-UNIVERSITAT-OBERTA-DE-CATALUNYA"],

  // Research & Innovation
  ["A l'Agència de Gestió d'Ajuts Universitaris i de Recerca (AGAUR)", "AGENCIA-DE-GESTIO-D-AJUTS-UNIVERSITARIS-I-DE-RECERCA"],
  ["A la Fundació Institució Catalana de Recerca i Estudis Avançats (ICREA)", "FUNDACIO-INSTITUCIO-CATALANA-DE-RECERCA-I-ESTUDIS-AVANCATS"],
  ["A l'Institut de Recerca i Tecnologia Agroalimentàries (IRTA)", "INSTITUT-DE-RECERCA-I-TECNOLOGIA-AGROALIMENTARIES"],
  ["A la Fundació Centre de Regulació Genòmica (CRG)", "FUNDACIO-CENTRE-DE-REGULACIO-GENOMICA"],
  ["A la Fundació Institut de Recerca Biomèdica (IRB Barcelona)", "FUNDACIO-INSTITUT-DE-RECERCA-BIOMEDICA"],

  // Housing & Territory
  ["A l'Agència de l'Habitatge de Catalunya", "AGENCIA-DE-L-HABITATGE-DE-CATALUNYA"],
  ["A l'Institut Català del Sòl (INCASÒL)", "INSTITUT-CATALA-DEL-SOL"],
  ["A l'Institut Cartogràfic i Geològic de Catalunya", "INSTITUT-CARTOGRAFIC-I-GEOLOGIC-DE-CATALUNYA"],

  // Economy & Business
  ["A l'Agència per a la Competitivitat de l'Empresa", "AGENCIA-PER-A-LA-COMPETITIVITAT-DE-L-EMPRESA"],
  ["A l'Institut Català de Finances (ICF)", "INSTITUT-CATALA-DE-FINANCES"],
  ["A l'Agència Catalana de Turisme", "AGENCIA-CATALANA-DE-TURISME"],
  ["A Circuits de Catalunya, SL", "CIRCUITS-DE-CATALUNYA-SL"],

  // Culture
  ["A l'Institut Català de les Empreses Culturals (ICEC)", "INSTITUT-CATALA-DE-LES-EMPRESES-CULTURALS"],
  ["A l'Oficina de Suport a la Iniciativa Cultural", "OFICINA-DE-SUPORT-A-LA-INICIATIVA-CULTURAL"],
  ["A l'Oficina de Suport a a la Iniciativa Cultural", "OFICINA-DE-SUPORT-A-LA-INICIATIVA-CULTURAL"],
  ["A l'Agència Catalana del Patrimoni Cultural", "AGENCIA-CATALANA-DEL-PATRIMONI-CULTURAL"],

  // Environment & Energy
  ["A l'Agència de Residus de Catalunya (ARC)", "AGENCIA-DE-RESIDUS-DE-CATALUNYA"],
  ["A l'Institut Català d'Energia (ICAEN)", "INSTITUT-CATALA-D-ENERGIA"],
  ["A l'Agència Catalana de l'Aigua", "AGENCIA-CATALANA-DE-L-AIGUA"],

  // Social Services
  ["Al Consorci d'Educació de Barcelona", "CONSORCI-D-EDUCACIO-DE-BARCELONA"],
  ["Al Consorci de Serveis Socials de Barcelona", "CONSORCI-DE-SERVEIS-SOCIALS-DE-BARCELONA"],
  ["Al Consorci per a la Formació Contínua de Catalunya", "CONSORCI-PER-A-LA-FORMACIO-CONTINUA-DE-CATALUNYA"],
  ["Al Consorci per a la Normalització Lingüística", "CONSORCI-PER-A-LA-NORMALITZACIO-LINGUISTICA"],

  // Justice & Public Admin
  ["A l'Agència Tributària de Catalunya", "AGENCIA-TRIBUTARIA-DE-CATALUNYA"],
  ["Al Centre d'Iniciatives per a la Reinserció (CIRE)", "CENTRE-D-INICIATIVES-PER-A-LA-REINSERCIO"],
  ["A l'Escola d'Administració Pública de Catalunya", "ESCOLA-D-ADMINISTRACIO-PUBLICA-DE-CATALUNYA"],
  ["A l'Agència de Ciberseguretat de Catalunya", "AGENCIA-DE-CIBERSEGURETAT-DE-CATALUNYA"],
  ["Al Centre d'Atenció i Gestió de Trucades d'Urgència 112 Catalunya", "CENTRE-D-ATENCIO-I-GESTIO-DE-TRUCADES-D-URGENCIA-112-CATALUNYA"],

  // Cooperation & International
  ["A l'Agència Catalana de Cooperació al Desenvolupament", "AGENCIA-CATALANA-DE-COOPERACIO-AL-DESENVOLUPAMENT"],
  ["Transferències al Conselh Generau dera Val d'Aran", "CONSELH-GENERAU-D-ARAN"],

  // Sport & Women
  ["Al Consell Català de l'Esport", "CONSELL-CATALA-DE-L-ESPORT"],
  ["A l'Institut Català de les Dones (ICD)", "INSTITUT-CATALA-DE-LES-DONES"],
  ["A l'Institut Català de l'Acolliment i l'Adopció", "INSTITUT-CATALA-DE-L-ACOLLIMENT-I-L-ADOPCIO"],

  // Infrastructures
  ["A Infraestructures de la Generalitat de Catalunya, SAU", "INFRAESTRUCTURES-DE-LA-GENERALITAT-DE-CATALUNYA-SAU"],
  ["Al Centre de la Propietat Forestal", "CENTRE-DE-LA-PROPIETAT-FORESTAL"],

  // ============================================================
  // Cap.8 art.87 equity contribution name variants
  // These use "Aportacions de capital a...", "Aportacions al fons patrimonial de..."
  // instead of "A la...", "Al..." used by Cap.4/7
  // ============================================================

  // --- CCMA (2.2B EUR) ---
  ["Aportacions de capital a la Corporació Catalana de Mitjans Audiovisuals (CCMA)", "CORP-CAT-DE-MITJANS-AUDIOVISUALS-SA"],
  ["Aportacions al fons patrimonial de la Corporació Catalana de Mitjans Audiovisuals (CCMA)", "CORP-CAT-DE-MITJANS-AUDIOVISUALS-SA"],
  ["Aportacions al fons patrimonial de la Corporació Catalana de Mitjans Audiovisuals", "CORP-CAT-DE-MITJANS-AUDIOVISUALS-SA"],
  ["Aportació de capital a la Corporació Catalana de Mitjans Audiovisuals (CCMA)", "CORP-CAT-DE-MITJANS-AUDIOVISUALS-SA"],

  // --- CatSalut (2.0B EUR) ---
  ["Aportacions de capital al Servei Català de la Salut (CatSalut)", "SERVEI-CATALA-DE-LA-SALUT"],
  ["Aportacions al fons patrimonial del Servei Català de la Salut (CatSalut)", "SERVEI-CATALA-DE-LA-SALUT"],
  ["Aportacions al fons patrimonial del Servei Català de la Salut", "SERVEI-CATALA-DE-LA-SALUT"],
  ["Aportacions de capital al Servei Català de la Salut", "SERVEI-CATALA-DE-LA-SALUT"],

  // --- IFERCAT (1.1B EUR) ---
  ["Aportacions de capital a Infraestructures Ferroviàries de Catalunya", "INFRAESTRUCTURES-FERROVIARIES-DE-CATALUNYA"],
  ["Aportacions de capital a Infraestructures Ferroviàries de Catalunya (IFERCAT)", "INFRAESTRUCTURES-FERROVIARIES-DE-CATALUNYA"],
  ["Aportacions al fons patrimonial d'Infraestructures Ferroviàries de Catalunya", "INFRAESTRUCTURES-FERROVIARIES-DE-CATALUNYA"],

  // --- FGC (912M EUR) ---
  ["Aportacions de capital a Ferrocarrils de la Generalitat de Catalunya", "FERROCARRILS-DE-LA-GENERALITAT-DE-CATALUNYA"],
  ["Aportacions al fons patrimonial de Ferrocarrils de la Generalitat de Catalunya", "FERROCARRILS-DE-LA-GENERALITAT-DE-CATALUNYA"],
  ["Aportacions al fons patrimonial de Ferrocarrils dela Generalitat", "FERROCARRILS-DE-LA-GENERALITAT-DE-CATALUNYA"],

  // --- ICF (Institut Català de Finances) ---
  ["Aportacions de capital a l'Institut Català de Finances (ICF)", "INSTITUT-CATALA-DE-FINANCES"],
  ["Aportacions de capital a l'Institut Català de Finances", "INSTITUT-CATALA-DE-FINANCES"],
  ["Aportacions al fons patrimonial de l'Institut Català de Finances", "INSTITUT-CATALA-DE-FINANCES"],
  ["Aportacions al fons patrimonial de l'Institut Català de Finances (ICF)", "INSTITUT-CATALA-DE-FINANCES"],

  // --- INCASOL ---
  ["Aportacions de capital a l'Institut Català del Sòl (INCASÒL)", "INSTITUT-CATALA-DEL-SOL"],
  ["Aportacions de capital a l'Institut Català del Sòl", "INSTITUT-CATALA-DEL-SOL"],
  ["Aportacions al fons patrimonial de l'Institut Català del Sòl", "INSTITUT-CATALA-DEL-SOL"],

  // --- Infraestructures de la Generalitat SAU ---
  ["Aportacions de capital a Infraestructures de la Generalitat de Catalunya, SAU", "INFRAESTRUCTURES-DE-LA-GENERALITAT-DE-CATALUNYA-SAU"],
  ["Aportacions de capital a Infraestructures de la Generalitat de Catalunya", "INFRAESTRUCTURES-DE-LA-GENERALITAT-DE-CATALUNYA-SAU"],
  ["Aportacions al fons patrimonial d'Infraestructures de la Generalitat de Catalunya, SAU", "INFRAESTRUCTURES-DE-LA-GENERALITAT-DE-CATALUNYA-SAU"],

  // --- ICS ---
  ["Aportacions de capital a l'Institut Català de la Salut (ICS)", "INSTITUT-CATALA-DE-LA-SALUT"],
  ["Aportacions de capital a l'Institut Català de la Salut", "INSTITUT-CATALA-DE-LA-SALUT"],
  ["Aportacions al fons patrimonial de l'Institut Català de la Salut", "INSTITUT-CATALA-DE-LA-SALUT"],

  // --- IRTA ---
  ["Aportacions de capital a l'Institut de Recerca i Tecnologia Agroalimentàries (IRTA)", "INSTITUT-DE-RECERCA-I-TECNOLOGIA-AGROALIMENTARIES"],
  ["Aportacions de capital a l'Institut de Recerca i Tecnologia Agroalimentàries", "INSTITUT-DE-RECERCA-I-TECNOLOGIA-AGROALIMENTARIES"],

  // --- Circuits de Catalunya ---
  ["Aportacions de capital a Circuits de Catalunya, SL", "CIRCUITS-DE-CATALUNYA-SL"],
  ["Aportacions al fons patrimonial de Circuits de Catalunya, SL", "CIRCUITS-DE-CATALUNYA-SL"],

  // --- Agència de l'Habitatge ---
  ["Aportacions de capital a l'Agència de l'Habitatge de Catalunya", "AGENCIA-DE-L-HABITATGE-DE-CATALUNYA"],
  ["Aportacions al fons patrimonial de l'Agència de l'Habitatge de Catalunya", "AGENCIA-DE-L-HABITATGE-DE-CATALUNYA"],

  // --- ACA (Agència Catalana de l'Aigua) ---
  ["Aportacions de capital a l'Agència Catalana de l'Aigua", "AGENCIA-CATALANA-DE-L-AIGUA"],
  ["Aportacions al fons patrimonial de l'Agència Catalana de l'Aigua", "AGENCIA-CATALANA-DE-L-AIGUA"],

  // --- Agència Tributària ---
  ["Aportacions de capital a l'Agència Tributària de Catalunya", "AGENCIA-TRIBUTARIA-DE-CATALUNYA"],

  // --- CIRE ---
  ["Aportacions de capital al Centre d'Iniciatives per a la Reinserció (CIRE)", "CENTRE-D-INICIATIVES-PER-A-LA-REINSERCIO"],

  // --- ICAEN ---
  ["Aportacions de capital a l'Institut Català d'Energia (ICAEN)", "INSTITUT-CATALA-D-ENERGIA"],
  ["Aportacions de capital a l'Institut Català d'Energia", "INSTITUT-CATALA-D-ENERGIA"],

  // --- ICEC ---
  ["Aportacions de capital a l'Institut Català de les Empreses Culturals (ICEC)", "INSTITUT-CATALA-DE-LES-EMPRESES-CULTURALS"],

  // --- Centre de la Propietat Forestal ---
  ["Aportacions de capital al Centre de la Propietat Forestal", "CENTRE-DE-LA-PROPIETAT-FORESTAL"],
  ["Aportacions de capital del Centre de la Propietat Forestal", "CENTRE-DE-LA-PROPIETAT-FORESTAL"],

  // --- SOC ---
  ["Aportacions de capital al Servei Públic d'Ocupació de Catalunya (SOC)", "SERVEI-PUBLIC-D-OCUPACIO-DE-CATALUNYA"],

  // --- AGAUR ---
  ["Aportacions de capital a l'Agència de Gestió d'Ajuts Universitaris i de Recerca (AGAUR)", "AGENCIA-DE-GESTIO-D-AJUTS-UNIVERSITARIS-I-DE-RECERCA"],

  // --- Consell Català de l'Esport ---
  ["Aportacions de capital al Consell Català de l'Esport", "CONSELL-CATALA-DE-L-ESPORT"],

  // --- ARC (Agència de Residus) ---
  ["Aportacions de capital a l'Agència de Residus de Catalunya (ARC)", "AGENCIA-DE-RESIDUS-DE-CATALUNYA"],
  ["Aportacions de capital a l'Agència de Residus de Catalunya", "AGENCIA-DE-RESIDUS-DE-CATALUNYA"],

  // --- Turisme ---
  ["Aportacions de capital a l'Agència Catalana de Turisme", "AGENCIA-CATALANA-DE-TURISME"],

  // --- Escola d'Administració Pública ---
  ["Aportacions de capital a l'Escola d'Administració Pública de Catalunya", "ESCOLA-D-ADMINISTRACIO-PUBLICA-DE-CATALUNYA"],

  // --- Consorci Mar Parc de Salut ---
  ["Aportacions de capital al Consorci Mar Parc de Salut de Barcelona", "CONSORCI-MAR-PARC-DE-SALUT-DE-BARCELONA"],
  ["Aportacions a fons propis del Consorci Mar Parc de Salut de Barcelona", "CONSORCI-MAR-PARC-DE-SALUT-DE-BARCELONA"],
  ["Aportacions a fons propis del Consorci Mar Parc deSalut de Barcelona", "CONSORCI-MAR-PARC-DE-SALUT-DE-BARCELONA"],
  ["Aportacions extraordinàries al Consorci Mar Parc de Salut de Barcelona per compensar pèrdues acumulades", "CONSORCI-MAR-PARC-DE-SALUT-DE-BARCELONA"],

  // --- Consorci d'Educació de Barcelona ---
  ["Aportacions de capital al Consorci d'Educació de Barcelona", "CONSORCI-D-EDUCACIO-DE-BARCELONA"],

  // --- ATM ---
  ["Aportacions de capital a l'Autoritat del Transport Metropolità", "AUTORITAT-DEL-TRANSPORT-METROPOLITA"],

  // --- Fira 2000 (no existing entity — will be created) ---
  ["Aportacions de capital a Fira 2000, SA", "FIRA-2000-SA"],
  ["Aportacions al fons patrimonial de Fira 2000, SA", "FIRA-2000-SA"],

  // --- EPLICSA / AVANÇSA ---
  ["Aportacions de capital a l'Empresa de Promoció i Localització Industrial de Catalunya, SA (AVANÇSA)", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],
  ["Aportacions de capital a l'Empresa de Promoció i Localització Industrial de Catalunya, SA", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],
  ["Aport. a compte de capital de l'Empresa de Promoció i Localització Industrial de Catalunya, SA", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],

  // --- Ens d'Abastament d'Aigua Ter-Llobregat ---
  ["Aportacions de capital a l'Ens d'Abastament d'Aigua Ter-Llobregat", "ENS-D-ABASTAMENT-D-AIGUA-TER-LLOBREGAT"],

  // --- Serveis Meteorològic ---
  ["Aportació al Servei Meteorològic de Catalunya per compensar pèrdues acumulades", "SERVEI-METEOROLOGIC-DE-CATALUNYA"],
  ["Aportacions de capital al Servei Meteorològic de Catalunya", "SERVEI-METEOROLOGIC-DE-CATALUNYA"],

  // --- Consorci de Serveis Socials de Barcelona ---
  ["Aportacions de capital al Consorci de Serveis Socials de Barcelona", "CONSORCI-DE-SERVEIS-SOCIALS-DE-BARCELONA"],

  // --- Institut Cartogràfic ---
  ["Aportacions de capital a l'Institut Cartogràfic i Geològic de Catalunya", "INSTITUT-CARTOGRAFIC-I-GEOLOGIC-DE-CATALUNYA"],

  // --- ICREA ---
  ["Aportacions de capital a la Fundació Institució Catalana de Recerca i Estudis Avançats (ICREA)", "FUNDACIO-INSTITUCIO-CATALANA-DE-RECERCA-I-ESTUDIS-AVANCATS"],

  // --- Ciberseguretat ---
  ["Aportacions de capital a l'Agència de Ciberseguretat de Catalunya", "AGENCIA-DE-CIBERSEGURETAT-DE-CATALUNYA"],

  // --- Conselh Generau ---
  ["Aportacions de capital al Conselh Generau dera Val d'Aran", "CONSELH-GENERAU-D-ARAN"],

  // --- 112 ---
  ["Aportacions de capital al Centre d'Atenció i Gestió de Trucades d'Urgència 112 Catalunya", "CENTRE-D-ATENCIO-I-GESTIO-DE-TRUCADES-D-URGENCIA-112-CATALUNYA"],

  // --- Institut Català de les Dones ---
  ["Aportacions de capital a l'Institut Català de les Dones (ICD)", "INSTITUT-CATALA-DE-LES-DONES"],

  // --- Institut Català de l'Acolliment ---
  ["Aportacions de capital a l'Institut Català de l'Acolliment i l'Adopció", "INSTITUT-CATALA-DE-L-ACOLLIMENT-I-L-ADOPCIO"],

  // --- Cooperació al Desenvolupament ---
  ["Aportacions de capital a l'Agència Catalana de Cooperació al Desenvolupament", "AGENCIA-CATALANA-DE-COOPERACIO-AL-DESENVOLUPAMENT"],

  // --- Competitivitat ---
  ["Aportacions de capital a l'Agència per a la Competitivitat de l'Empresa", "AGENCIA-PER-A-LA-COMPETITIVITAT-DE-L-EMPRESA"],

  // --- Normalització Lingüística ---
  ["Aportacions de capital al Consorci per a la Normalització Lingüística", "CONSORCI-PER-A-LA-NORMALITZACIO-LINGUISTICA"],

  // --- Formació Contínua ---
  ["Aportacions de capital al Consorci per a la Formació Contínua de Catalunya", "CONSORCI-PER-A-LA-FORMACIO-CONTINUA-DE-CATALUNYA"],

  // --- Patrimoni Cultural ---
  ["Aportacions de capital a l'Agència Catalana del Patrimoni Cultural", "AGENCIA-CATALANA-DEL-PATRIMONI-CULTURAL"],

  // --- Oficina Suport Iniciativa Cultural ---
  ["Aportacions de capital a l'Oficina de Suport a la Iniciativa Cultural", "OFICINA-DE-SUPORT-A-LA-INICIATIVA-CULTURAL"],

  // --- Coordinació Logística Sanitària ---
  ["Aportacions de capital a Coordinació Logística Sanitària, AIE", "COORDINACIO-LOGISTICA-SANITARIA-AIE"],

  // ============================================================
  // Cap.8 SODA typo variants (missing spaces in source data)
  // These create wrong slugs if not manually mapped
  // ============================================================

  // "Habitatgede" = "Habitatge de" (375M EUR)
  ["Aportacions de capital a l'Agència de l'Habitatgede Catalunya", "AGENCIA-DE-L-HABITATGE-DE-CATALUNYA"],
  ["Aportacions al fons patrimonial de l'Agència de l'Habitatgede Catalunya", "AGENCIA-DE-L-HABITATGE-DE-CATALUNYA"],

  // "Catalade" = "Català de" (355M EUR — CatSalut)
  ["Aportacions de capital al Servei Catalàde la Salut", "SERVEI-CATALA-DE-LA-SALUT"],
  ["Aportacions de capital al Servei Catalàde la Salut (CatSalut)", "SERVEI-CATALA-DE-LA-SALUT"],
  ["Aportacions al fons patrimonial del Servei Catalàde la Salut", "SERVEI-CATALA-DE-LA-SALUT"],

  // "Infraestructuresferroviaries" = "Infraestructures Ferroviàries" (304M EUR)
  ["Aportacions de capital a Infraestructuresferroviàries de Catalunya", "INFRAESTRUCTURES-FERROVIARIES-DE-CATALUNYA"],
  ["Aportacions de capital a Infraestructures ferroviàries de Catalunya", "INFRAESTRUCTURES-FERROVIARIES-DE-CATALUNYA"],
  ["Aportacions al fons patrimonial d'Infraestructuresferroviàries de Catalunya", "INFRAESTRUCTURES-FERROVIARIES-DE-CATALUNYA"],
  ["Aportacions al fons patrimonial d'InfraestructuresFerroviàries de Catalunya", "INFRAESTRUCTURES-FERROVIARIES-DE-CATALUNYA"],
  ["Aportacions al fons patrimonial de Infraestructuresferroviàries de Catalunya", "INFRAESTRUCTURES-FERROVIARIES-DE-CATALUNYA"],

  // "Infraestructuresde" = "Infraestructures de" (109M EUR)
  ["Aportacions a compte de capital d'Infraestructuresde la Generalitat de Catalunya, SAU", "INFRAESTRUCTURES-DE-LA-GENERALITAT-DE-CATALUNYA-SAU"],
  ["Aportacions de capital a Infraestructuresde la Generalitat de Catalunya, SAU", "INFRAESTRUCTURES-DE-LA-GENERALITAT-DE-CATALUNYA-SAU"],

  // EPLICSA / AVANÇSA typo variants (72M + 70M EUR)
  ["Aportacions de capital a l'Empr. Promoció i Localització Industrial de Cat., S.A. (AVANÇSA)", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],
  ["Aportacions al fons patrimonial de l'Empr. Promoció i Localització Industrial de Cat.", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],
  ["Aport. a compte de capital de l'Empr. Promoció i Localització Industrial de Cat., S.A.", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],
  ["Aport. a compte de capital de l'Empr. Promoció i Localització Industrial de Cat. (EPLICSA)", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],
  ["Aport. a compte de capital de l'Empr. Promoció i Localització Industrial de Cat.", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],
  ["Aportacions de capital a l'Empresa de Promoció i Localització Industrial de Catalunya, SA (AVANÇSA)", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],
  ["Aportacions de capital a l'Empresa de Promoció i Localització Industrial de Catalunya, SA", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],
  ["Aportacions al fons patrimonial de l'Empresa de Promoció i Localització Industrial de Catalunya, SA", "EMPRESA-DE-PROMOCIO-I-LOCALITZACIO-INDUSTRIAL-DE-CATALUNYA-SA"],

  // Hospital Clínic de Barcelona
  ["Aportacions de capital a l'Hospital Clínic de Barcelona", "HOSPITAL-CLINIC-DE-BARCELONA"],
  ["Aportacions al fons patrimonial de l'Hospital Clínic de Barcelona", "HOSPITAL-CLINIC-DE-BARCELONA"],

  // Energies Renovables Públiques de Catalunya
  ["Aportacions de capital a Energies Renovables Públiques de Catalunya, SAU", "ENERGIES-RENOVABLES-PUBLIQUES-DE-CATALUNYA-SAU"],

  // Consorci Sanitari Integral
  ["Aportacions de capital al Consorci Sanitari Integral", "CONSORCI-SANITARI-INTEGRAL"],
  ["Aportacions a fons propis del Consorci Sanitari Integral", "CONSORCI-SANITARI-INTEGRAL"],

  // Hospital Santa Creu i Sant Pau
  ["Aportacions de capital a la Fundació de Gestió Sanitària de l'Hospital de la Santa Creu i Sant Pau", "FUNDACIO-DE-GESTIO-SANITARIA-DE-L-HOSPITAL-DE-LA-SANTA-CREU-I-SANT-PAU"],
  ["Aportacions a fons propis de la Fundació de Gestió Sanitària de l'Hospital de la Santa Creu i Sant Pau", "FUNDACIO-DE-GESTIO-SANITARIA-DE-L-HOSPITAL-DE-LA-SANTA-CREU-I-SANT-PAU"],

  // Teatre Nacional
  ["Aportacions de capital al Teatre Nacional de Catalunya, SA (TNC)", "TEATRE-NACIONAL-DE-CATALUNYA-SA"],
  ["Aportacions a compte de capital del Teatre Nacional de Catalunya, SA (TNC)", "TEATRE-NACIONAL-DE-CATALUNYA-SA"],

  // Corporació Sanitària Parc Taulí
  ["Aportacions a fons propis de la Corporació Sanitària Parc Taulí de Sabadell", "CORPORACIO-SANITARIA-PARC-TAULI-DE-SABADELL"],
  ["Aportacions de capital a la Corporació Sanitària Parc Taulí de Sabadell", "CORPORACIO-SANITARIA-PARC-TAULI-DE-SABADELL"],

  // Consorci Administració Oberta de Catalunya
  ["Aportacions a fons propis del Consorci Administració Oberta de Catalunya", "CONSORCI-ADMINISTRACIO-OBERTA-DE-CATALUNYA"],
  ["Aportacions de capital al Consorci Administració Oberta de Catalunya", "CONSORCI-ADMINISTRACIO-OBERTA-DE-CATALUNYA"],

  // SEM (Sistema d'Emergències Mèdiques)
  ["Aportacions de capital de Sistema d'Emergències Mèdiques, SA", "SISTEMA-D-EMERGENCIES-MEDIQUES-SA"],
  ["Aportacions de capital a Sistema d'Emergències Mèdiques, SA", "SISTEMA-D-EMERGENCIES-MEDIQUES-SA"],

  // Laboratori Llum Sincrotó (ALBA)
  ["Aportació a fons propis del Consorci construcció,equipament i explotació del Laboratori de Llum Sincrotó", "CONSORCI-CONSTRUCCIO-EQUIPAMENT-I-EXPLOTACIO-DEL-LABORATORI-DE-LLUM-SINCROTO"],
  ["Aportacions a fons propis del Consorci construcció,equipament i explotació del Laboratori de Llum Sincrotó", "CONSORCI-CONSTRUCCIO-EQUIPAMENT-I-EXPLOTACIO-DEL-LABORATORI-DE-LLUM-SINCROTO"],

  // Barcelona Supercomputing Center
  ["Aportació a fons propis del Consorci Barcelona Supercomputing Center", "CONSORCI-BARCELONA-SUPERCOMPUTING-CENTER"],
  ["Aportacions a fons propis del Consorci Barcelona Supercomputing Center", "CONSORCI-BARCELONA-SUPERCOMPUTING-CENTER"],

  // ServeisUniversitaris typo
  ["Aportacions a fons propis del Consorci de ServeisUniversitaris de Catalunya", "CONSORCI-DE-SERVEIS-UNIVERSITARIS-DE-CATALUNYA"],

  // PRODECA
  ["Aportacions a compte de capital de Promotora d'Exportacions Catalanes, SA (PRODECA)", "PROMOTORA-D-EXPORTACIONS-CATALANES-SA"],
  ["Aportacions de capital a Promotora d'Exportacions Catalanes, SA (PRODECA)", "PROMOTORA-D-EXPORTACIONS-CATALANES-SA"],

  // Circuit de Motocròs
  ["Aportacions a compte de capital del Circuit de Motocròs de Catalunya, SL", "CIRCUIT-DE-MOTOCROS-DE-CATALUNYA-SL"],

  // Escola Industrial de Barcelona
  ["Aportacions a fons propis del Consorci Escola Industrial de Barcelona", "CONSORCI-ESCOLA-INDUSTRIAL-DE-BARCELONA"],

  // Gran Teatre del Liceu
  ["Aportacions a fons propis del Consorci del Gran Teatre del Liceu", "CONSORCI-DEL-GRAN-TEATRE-DEL-LICEU"],
  ["Aportacions de capital al Consorci del Gran Teatre del Liceu", "CONSORCI-DEL-GRAN-TEATRE-DEL-LICEU"],

  // Escola Tècnica d'Igualada
  ["Aportacions a fons propis del Consorci Escola Tècnica d'Igualada", "CONSORCI-ESCOLA-TECNICA-D-IGUALADA"],

  // Hospital de la Cerdanya
  ["Ap. a fons propis Agrup. Europ. Cooper. Territoririal  Hospital de la Cerdanya", "AGRUPACIO-EUROPEA-DE-COOPERACIO-TERRITORIAL-HOSPITAL-DE-LA-CERDANYA"],

  // Consorci Sanitari typo variants (missing spaces in SODA data)
  ["Aportacions a fons propis del Consorci Sanitari deTerrassa", "CONSORCI-SANITARI-DE-TERRASSA"],
  ["Aportacions a fons propis del Consorci Sanitari del'Anoia", "CONSORCI-SANITARI-DE-L-ANOIA"],
  ["Aportacions a fons propis del Consorci Sanitari del'Alt Penedès", "CONSORCI-SANITARI-DE-L-ALT-PENEDES"],
  ["Aportacions a fons propis del Consorci Hospitalaride Vic", "CONSORCI-HOSPITALARI-DE-VIC"],
  ["Aportacions a fons propis del Consorci Mar Parc deSalut de Barcelona", "CONSORCI-MAR-PARC-DE-SALUT-DE-BARCELONA"],
]);

// ============================================================
// Helpers
// ============================================================

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(name: string): string {
  return name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bS\.\s*A\.\s*U\b\.?/g, "SAU")
    .replace(/\bS\.\s*A\b\.?/g, "SA")
    .replace(/\bS\.\s*L\.\s*U\b\.?/g, "SLU")
    .replace(/\bS\.\s*L\b\.?/g, "SL")
    .replace(/\bS\.\s*C\.\s*C\.\s*L\b\.?/g, "SCCL")
    .replace(/\bS\.\s*C\.\s*P\b\.?/g, "SCP")
    .replace(/\bS\.\s*C\b\.?/g, "SC")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseAmount(val: string | undefined): number {
  if (!val) return 0;
  const num = parseFloat(val);
  return isNaN(num) ? 0 : num;
}

function esc(val: string | null | undefined): string {
  if (val === null || val === undefined) return "NULL";
  return "'" + val.replace(/'/g, "''").replace(/\\/g, "\\\\") + "'";
}

function escNum(val: number | null): string {
  if (val === null || val === undefined) return "0";
  return String(val);
}

function psqlCmd(): string {
  // The connection travels as libpq variables (see psqlEnv), never on the command line.
  return "psql -X -t -A";
}

function psqlEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...libpqEnv() };
}

function runSQL(label: string, sql: string): string {
  try {
    const result = execSync(psqlCmd(), {
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
      env: psqlEnv(),
      shell: "/bin/bash",
    });
    return result.toString().trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString().trim() || "";
    if (stderr && !stderr.includes("NOTICE") && !stderr.includes("duplicate key")) {
      console.error(`  SQL error (${label}): ${stderr.substring(0, 300)}`);
    }
    return e.stdout?.toString().trim() || "";
  }
}

function runSQLFile(label: string, sql: string): string {
  const tmpFile = join(tmpdir(), `menjometre_pressupostos_${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, sql, "utf8");
    const result = execSync(
      `cat "${tmpFile}" | ${psqlCmd()} 2>&1`,
      {
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 50 * 1024 * 1024,
        env: psqlEnv(),
        shell: "/bin/bash",
      }
    );
    const output = result.toString().trim();
    if (output.includes("ERROR")) {
      console.error(`  SQL error (${label}): ${output.substring(0, 500)}`);
    }
    return output;
  } catch (e: any) {
    const stderr = e.stderr?.toString().trim() || "";
    const stdout = e.stdout?.toString().trim() || "";
    if (stderr) {
      console.error(`  SQL file error (${label}): ${stderr.substring(0, 500)}`);
    }
    if (stdout && stdout.includes("ERROR")) {
      console.error(`  SQL stdout error (${label}): ${stdout.substring(0, 500)}`);
    }
    return stdout;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ============================================================
// Entity matching
// ============================================================

/**
 * Normalize SODA aplicaci text before processing.
 * SODA data contains double spaces, inconsistent casing, and typos.
 */
function normalizeAplicaci(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Check if a record is Cap.8 article 87 (equity contributions).
 */
function isCap8Art87(record: SodaBudgetRecord): boolean {
  return record.cap_tol_codi === "8" && record.article_codi === "87";
}

/**
 * Skip generic multi-recipient budget lines.
 * Cap.8 art.87 records are always entity-specific (the article code guarantees it),
 * so SKIP_PATTERNS must NOT apply to them.
 */
function shouldSkip(aplicaci: string, isEquity: boolean): boolean {
  if (isEquity) return false; // art.87 is always entity-specific
  const lower = aplicaci.toLowerCase();
  return SKIP_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * Parse entity name from the budget line `aplicaci` field.
 * Cap.4/7 lines: "A la Corporació...", "Al Servei...", "A l'Institut..."
 * Cap.8 lines: "Aportacions de capital a la...", "Aportacions al fons patrimonial de..."
 */
function extractEntityName(aplicaci: string): string {
  let name = normalizeAplicaci(aplicaci);
  const original = name;

  // Cap.8 prefixes — ordered longest-first, with typo tolerance
  const cap8Prefixes = [
    /^Aportacions de capital i altres fons propis a\s+/i,
    /^Aportacions extraordin[aà]ries a la\s+/i,
    /^Aportacions extraordin[aà]ries al\s+/i,
    /^Aportacions extraordin[aà]ries a l['']/i,
    /^Aportacions extraordin[aà]ries a\s+/i,
    /^Aportacions al fons patrimonial de la\s+/i,
    /^Aportacions al fons patrimonial del\s+/i,
    /^Aportacions al fons patrimonial de l['']/i,
    /^Aportacions al fons patrimonial d['']/i,
    /^Aportacions al fons patrimonial de\s+/i,
    /^Aportacions a fons propis de la\s+/i,
    /^Aportacions a fons propis del\s+/i,
    /^Aportacions a fons propis de l['']/i,
    /^Aportacions? de capita?l? a la\s+/i,
    /^Aportacions? de capita?l? al\s+/i,
    /^Aportacions? de capita?l? a l['']/i,
    /^Aportacions? de capita?l? del\s+/i,
    /^Aportacions? de capita?l? de l['']/i,
    /^Aportacions? de capita?l? de\s+/i,
    /^Aportacions? de capita?l? d['']/i,
    /^Aportacions? de capita?l? a\s+/i,
    /^Aportacions capital a\s+/i,
    /^Aportaci[oó] de capital al\s+/i,
    /^Aportaci[oó] de capital a la\s+/i,
    /^Aportaci[oó] de capital a l['']/i,
    /^Aportaci[oó] a fons propis del\s+/i,
    /^Aportaci[oó] extraordin[aà]ria a\s+/i,
    /^Aportaci[oó] al\s+/i,
    /^Aportacions a compte de capital de l['']/i,
    /^Aportacions a compte de capital d['']/i,
    /^Aportacions a compte de capital del?\s+/i,
    /^Aport\.\s*extraordin[aà]ries de la GC[^]*/i,
    /^Aport\.\s*al fons patrimonial de l['']/i,
    /^Aport\.\s*al fons patrimonial del\s+/i,
    /^Aport\.\s*a compte de capital de l['']/i,
    /^Aport\.\s*a compte de capital de\s+/i,
    /^Aport\.\s*de capital al\s+/i,
    /^Aport\.\s*de capital a l['']/i,
    /^Aport\.\s*de capital a\s+/i,
    /^Aport\.\s*a fons propis del?\s+/i,
    /^Ap\.\s*a fons propis/i,
  ];

  for (const re of cap8Prefixes) {
    if (re.test(name)) {
      name = name.replace(re, "");
      break;
    }
  }

  // Existing Cap.4/7 prefixes (only if Cap.8 didn't match)
  if (name === original) {
    name = name
      .replace(/^A la\s+/i, "")
      .replace(/^Al\s+/i, "")
      .replace(/^A l['']/i, "")
      .replace(/^A\s+/i, "")
      .trim();
  }

  return name.trim();
}

function matchEntity(aplicaci: string, isEquity: boolean): { slug: string; name: string; tier: "manual" | "auto" } | null {
  // Normalize first for consistent matching
  const normalized = normalizeAplicaci(aplicaci);

  // Tier 1: exact manual mapping (try both original and normalized)
  const mappedSlug = ENTITY_MAPPING.get(aplicaci) || ENTITY_MAPPING.get(normalized);
  if (mappedSlug) {
    return { slug: mappedSlug, name: extractEntityName(aplicaci), tier: "manual" };
  }

  // Also try with common variations (startsWith)
  for (const [key, slug] of ENTITY_MAPPING.entries()) {
    if (normalized.startsWith(key) || aplicaci.startsWith(key)) {
      return { slug, name: extractEntityName(aplicaci), tier: "manual" };
    }
  }

  // Tier 2: automatic slug matching
  if (shouldSkip(aplicaci, isEquity)) return null;

  const entityName = extractEntityName(aplicaci);
  if (!entityName || entityName.length < 3) return null;

  // Strip parenthetical abbreviations for slugification
  const nameForSlug = entityName.replace(/\s*\([^)]+\)\s*$/, "").trim();
  const slug = slugify(nameForSlug);

  if (!slug || slug.length < 3) return null;

  return { slug, name: entityName, tier: "auto" };
}

// ============================================================
// SODA API client
// ============================================================

async function fetchSodaPage(offset: number, year?: string, cap8Only?: boolean): Promise<SodaBudgetRecord[]> {
  const chapterFilter = cap8Only
    ? `cap_tol_codi='8' AND article_codi='87'`
    : `(cap_tol in('${TRANSFER_CHAPTERS.join("','")}') OR (cap_tol_codi='8' AND article_codi='87'))`;

  const whereClause = [
    chapterFilter,
    `mes='12 Desembre'`,
    year ? `exercici='${year}'` : null,
  ].filter(Boolean).join(" AND ");

  const params = new URLSearchParams({
    $where: whereClause,
    $limit: String(BATCH_SIZE),
    $offset: String(offset),
    $order: "exercici,aplicaci",
  });

  const url = `${SODA_BASE}?${params}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await sleep(RATE_LIMIT_MS);
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Menjometre/1.0 (open data observatory)",
        },
      });

      if (response.status === 429 || response.status >= 500) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`  SODA API ${response.status}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        throw new Error(`SODA API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as SodaBudgetRecord[];
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`  Fetch error: ${(err as Error).message}, retrying...`);
      await sleep(delay);
    }
  }

  throw new Error("Unreachable");
}

// ============================================================
// Processing + SQL insert
// ============================================================

interface BudgetRow {
  entity_slug: string;
  entity_name: string;
  budget_name_raw: string;
  fiscal_year: number;
  budget_chapter: string;
  department: string;
  budget_line: string;
  initial_budget: number;
  approved_budget: number;
  executed_amount: number;
  cap_tol_codi: number | null;
  article_codi: number | null;
  match_tier: "manual" | "auto";
}

function processRecords(records: SodaBudgetRecord[]): { rows: BudgetRow[]; skipped: number; unmatched: string[]; autoSlugEquity: string[] } {
  const rows: BudgetRow[] = [];
  let skipped = 0;
  const unmatchedSet = new Set<string>();
  const autoSlugEquitySet = new Set<string>();

  for (const record of records) {
    const aplicaci = record.aplicaci?.trim();
    if (!aplicaci) { skipped++; continue; }

    const year = parseInt(record.exercici || "0", 10);
    if (year < 2014 || year > 2030) { skipped++; continue; }

    const executed = parseAmount(record.obligacions_reconegudes);
    const approved = parseAmount(record.pressupost_definitiu);
    const initial = parseAmount(record.cr_dits_inicials);

    // Skip zero-amount lines
    if (executed === 0 && approved === 0) { skipped++; continue; }

    const isEquity = isCap8Art87(record);

    // Skip generic/multi-recipient lines (bypassed for Cap.8 art.87)
    if (shouldSkip(aplicaci, isEquity)) { skipped++; continue; }

    // Match entity
    const match = matchEntity(aplicaci, isEquity);
    if (!match) {
      unmatchedSet.add(`${aplicaci} (${(executed / 1e6).toFixed(1)}M)`);
      skipped++;
      continue;
    }

    // Warn if Cap.8 equity falls through to auto-slug (risky — no CIF cross-check)
    if (isEquity && match.tier === "auto") {
      autoSlugEquitySet.add(`${aplicaci} → ${match.slug} (${(executed / 1e6).toFixed(1)}M)`);
    }

    const capToiCodi = parseInt(record.cap_tol_codi || "0", 10) || null;
    const articleCodi = parseInt(record.article_codi || "0", 10) || null;

    rows.push({
      entity_slug: match.slug,
      entity_name: match.name,
      budget_name_raw: aplicaci,
      fiscal_year: year,
      budget_chapter: record.cap_tol || "Transferències corrents",
      department: record.secci || "Desconegut",
      budget_line: aplicaci,
      initial_budget: initial,
      approved_budget: approved,
      executed_amount: executed,
      cap_tol_codi: capToiCodi,
      article_codi: articleCodi,
      match_tier: match.tier,
    });
  }

  return { rows, skipped, unmatched: Array.from(unmatchedSet), autoSlugEquity: Array.from(autoSlugEquitySet) };
}

function upsertEntities(rows: BudgetRow[]): number {
  const entityMap = new Map<string, string>();
  for (const row of rows) {
    if (!entityMap.has(row.entity_slug)) {
      entityMap.set(row.entity_slug, row.entity_name);
    }
  }

  const entities = Array.from(entityMap.entries());
  if (entities.length === 0) return 0;

  for (let i = 0; i < entities.length; i += SQL_BATCH) {
    const chunk = entities.slice(i, i + SQL_BATCH);
    const values = chunk.map(([slug, name]) =>
      `(${esc(slug)}, ${esc(name)}, TRUE)`
    ).join(",\n");

    runSQLFile("upsert entities", `
      INSERT INTO entities (slug, name, is_public_entity)
      VALUES ${values}
      ON CONFLICT (slug) DO UPDATE SET
        is_public_entity = TRUE,
        updated_at = NOW();
    `);
  }

  return entities.length;
}

function insertBudgetTransfers(rows: BudgetRow[]): { inserted: number } {
  if (rows.length === 0) return { inserted: 0 };

  // Deduplicate: include budget_chapter in key to prevent cross-chapter overwrites
  const dedup = new Map<string, BudgetRow>();
  for (const row of rows) {
    const key = `${row.entity_slug}|${row.fiscal_year}|${row.budget_line}|${row.department}|${row.budget_chapter}`;
    const existing = dedup.get(key);
    if (!existing || row.executed_amount > existing.executed_amount) {
      dedup.set(key, row);
    }
  }
  const uniqueRows = Array.from(dedup.values());
  console.log(`  Deduped: ${rows.length} → ${uniqueRows.length} unique rows`);

  let total = 0;

  for (let i = 0; i < uniqueRows.length; i += SQL_BATCH) {
    const chunk = uniqueRows.slice(i, i + SQL_BATCH);
    const values = chunk.map(r =>
      `(${esc(r.entity_slug)}, ${esc(r.budget_name_raw)}, ${r.fiscal_year}, ${esc(r.budget_chapter)}, ${esc(r.department)}, ${esc(r.budget_line)}, ${escNum(r.initial_budget)}, ${escNum(r.approved_budget)}, ${escNum(r.executed_amount)}, ${r.cap_tol_codi !== null ? r.cap_tol_codi : 'NULL'}, ${r.article_codi !== null ? r.article_codi : 'NULL'})`
    ).join(",\n");

    const result = runSQLFile("insert budget_transfers", `
      INSERT INTO budget_transfers (entity_slug, budget_name_raw, fiscal_year, budget_chapter, department, budget_line, initial_budget, approved_budget, executed_amount, cap_tol_codi, article_codi)
      VALUES ${values}
      ON CONFLICT (entity_slug, fiscal_year, budget_line, department) WHERE entity_slug IS NOT NULL DO UPDATE SET
        initial_budget = EXCLUDED.initial_budget,
        approved_budget = EXCLUDED.approved_budget,
        executed_amount = EXCLUDED.executed_amount,
        cap_tol_codi = COALESCE(EXCLUDED.cap_tol_codi, budget_transfers.cap_tol_codi),
        article_codi = COALESCE(EXCLUDED.article_codi, budget_transfers.article_codi);
    `);

    const insertCount = (result.match(/INSERT/g) || []).length;
    total += chunk.length;
  }

  // Backfill entity_id
  runSQL("backfill entity_id", `
    UPDATE budget_transfers bt SET entity_id = e.id
    FROM entities e WHERE bt.entity_slug = e.slug AND bt.entity_id IS NULL;
  `);

  return { inserted: total };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const skipAggregation = args.includes("--skip-aggregation");
  const cap8Only = args.includes("--cap8-only");

  console.log("=== Menjometre Budget Transfers Sync ===");
  console.log(`Mode: ${isDryRun ? "DRY RUN" : "LIVE"}${cap8Only ? " (Cap.8 art.87 only)" : ""}`);
  console.log("Target: DATABASE_URL");
  console.log(`Source: ${SODA_BASE}`);
  console.log(`Filter: ${cap8Only ? "Cap.8 art.87 equity contributions" : "Transfer chapters + Cap.8 art.87"}, December snapshots only\n`);

  let totalFetched = 0;
  let totalSkipped = 0;
  let totalEntities = 0;
  const allUnmatched: string[] = [];
  const allAutoSlugEquity: string[] = [];

  // Fetch all pages
  let offset = 0;
  let allRows: BudgetRow[] = [];

  while (true) {
    console.log(`  Fetching offset ${offset}...`);
    const records = await fetchSodaPage(offset, undefined, cap8Only);
    console.log(`  Got ${records.length} records`);
    totalFetched += records.length;

    if (records.length === 0) break;

    const { rows, skipped, unmatched, autoSlugEquity } = processRecords(records);
    allRows.push(...rows);
    totalSkipped += skipped;
    allUnmatched.push(...unmatched);
    allAutoSlugEquity.push(...autoSlugEquity);

    if (records.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  // Split stats by chapter type
  const cap8Rows = allRows.filter(r => r.cap_tol_codi === 8);
  const otherRows = allRows.filter(r => r.cap_tol_codi !== 8);
  const cap8Amount = cap8Rows.reduce((s, r) => s + r.executed_amount, 0);
  const otherAmount = otherRows.reduce((s, r) => s + r.executed_amount, 0);

  console.log(`\n  Total fetched: ${totalFetched}`);
  console.log(`  Matched rows: ${allRows.length} (Cap.4/7: ${otherRows.length}, Cap.8: ${cap8Rows.length})`);
  console.log(`  Amount: Cap.4/7 ${(otherAmount / 1e9).toFixed(2)}B + Cap.8 ${(cap8Amount / 1e9).toFixed(2)}B = ${((cap8Amount + otherAmount) / 1e9).toFixed(2)}B EUR`);
  console.log(`  Skipped: ${totalSkipped}`);

  // Match tier stats
  const manualCount = allRows.filter(r => r.match_tier === "manual").length;
  const autoCount = allRows.filter(r => r.match_tier === "auto").length;
  console.log(`  Match tiers: manual=${manualCount}, auto-slug=${autoCount}`);

  // WARN: Cap.8 equity records matched by auto-slug (risky — no CIF cross-check)
  if (allAutoSlugEquity.length > 0) {
    console.log(`\n  ⚠ WARNING: ${allAutoSlugEquity.length} Cap.8 equity records matched by AUTO-SLUG (no CIF cross-check!):`);
    for (const entry of allAutoSlugEquity.slice(0, 20)) {
      console.log(`    - ${entry}`);
    }
    if (allAutoSlugEquity.length > 20) {
      console.log(`    ... and ${allAutoSlugEquity.length - 20} more`);
    }
  }

  if (allUnmatched.length > 0) {
    console.log(`\n  UNMATCHED budget lines (${allUnmatched.length}):`);
    const sorted = allUnmatched.sort((a, b) => {
      const amtA = parseFloat(a.match(/\(([0-9.]+)M\)/)?.[1] || "0");
      const amtB = parseFloat(b.match(/\(([0-9.]+)M\)/)?.[1] || "0");
      return amtB - amtA;
    });
    for (const name of sorted.slice(0, 30)) {
      console.log(`    - ${name}`);
    }
    if (sorted.length > 30) {
      console.log(`    ... and ${sorted.length - 30} more`);
    }
  }

  if (isDryRun) {
    console.log("\n  DRY RUN — no data written.");
    // Show summary by year, split by chapter type
    const byYear = new Map<number, { cap47: number; cap8: number; cap47Amt: number; cap8Amt: number }>();
    for (const row of allRows) {
      const entry = byYear.get(row.fiscal_year) || { cap47: 0, cap8: 0, cap47Amt: 0, cap8Amt: 0 };
      if (row.cap_tol_codi === 8) {
        entry.cap8++;
        entry.cap8Amt += row.executed_amount;
      } else {
        entry.cap47++;
        entry.cap47Amt += row.executed_amount;
      }
      byYear.set(row.fiscal_year, entry);
    }
    console.log("\n  By year:");
    for (const [year, d] of Array.from(byYear.entries()).sort((a, b) => a[0] - b[0])) {
      const parts = [];
      if (d.cap47 > 0) parts.push(`Cap.4/7: ${d.cap47} lines ${(d.cap47Amt / 1e9).toFixed(2)}B`);
      if (d.cap8 > 0) parts.push(`Cap.8: ${d.cap8} lines ${(d.cap8Amt / 1e9).toFixed(2)}B`);
      console.log(`    ${year}: ${parts.join(" | ")}`);
    }

    // Show distinct Cap.8 entities
    if (cap8Rows.length > 0) {
      const cap8Entities = new Map<string, number>();
      for (const r of cap8Rows) {
        cap8Entities.set(r.entity_slug, (cap8Entities.get(r.entity_slug) || 0) + r.executed_amount);
      }
      console.log(`\n  Distinct Cap.8 entities: ${cap8Entities.size}`);
      const sorted = Array.from(cap8Entities.entries()).sort((a, b) => b[1] - a[1]);
      for (const [slug, amt] of sorted.slice(0, 20)) {
        console.log(`    ${(amt / 1e6).toFixed(1)}M EUR — ${slug}`);
      }
      if (sorted.length > 20) {
        console.log(`    ... and ${sorted.length - 20} more`);
      }
    }

    return;
  }

  // Upsert entities
  console.log("\n  Upserting entities...");
  totalEntities = upsertEntities(allRows);
  console.log(`  Upserted ${totalEntities} entities`);

  // Insert budget transfers
  console.log("  Inserting budget transfers...");
  const { inserted } = insertBudgetTransfers(allRows);
  console.log(`  Inserted/updated ${inserted} budget transfer rows`);

  if (!skipAggregation) {
    // Aggregate Cap.4/7 budget transfers (operational transfers)
    console.log("\n  Aggregating operational transfers (Cap.4/7) per entity...");
    runSQL("aggregate operational transfers", `
      WITH bt_agg AS (
        SELECT entity_id, SUM(executed_amount) as total_bt
        FROM budget_transfers
        WHERE entity_id IS NOT NULL AND (cap_tol_codi IS NULL OR cap_tol_codi IN (4, 7))
        GROUP BY entity_id
      )
      UPDATE entities e SET
        total_budget_transfers = COALESCE(bt_agg.total_bt, 0),
        updated_at = NOW()
      FROM bt_agg WHERE e.id = bt_agg.entity_id;
    `);

    // Aggregate Cap.8 art.87 equity contributions (separate column)
    console.log("  Aggregating equity contributions (Cap.8 art.87) per entity...");
    runSQL("aggregate equity contributions", `
      WITH eq_agg AS (
        SELECT entity_id, SUM(executed_amount) as total_eq
        FROM budget_transfers
        WHERE entity_id IS NOT NULL AND cap_tol_codi = 8 AND article_codi = 87
        GROUP BY entity_id
      )
      UPDATE entities e SET
        total_equity_contributions = COALESCE(eq_agg.total_eq, 0),
        updated_at = NOW()
      FROM eq_agg WHERE e.id = eq_agg.entity_id;
    `);

    // Update total_public_funds (includes both operational + equity)
    console.log("  Updating total_public_funds...");
    runSQL("update total_public_funds", `
      UPDATE entities SET
        total_public_funds = COALESCE(total_amount, 0) + COALESCE(total_contract_amount, 0) + COALESCE(total_budget_transfers, 0) + COALESCE(total_equity_contributions, 0)
      WHERE total_budget_transfers > 0 OR total_equity_contributions > 0;
    `);

    // Show top 10 by operational transfers
    const top10 = runSQL("top 10 operational", `
      SELECT name, slug, total_budget_transfers, total_equity_contributions
      FROM entities
      WHERE total_budget_transfers > 0 OR total_equity_contributions > 0
      ORDER BY total_budget_transfers + total_equity_contributions DESC
      LIMIT 10;
    `);
    console.log("\n  Top 10 budget recipients (transfers + equity):");
    for (const line of top10.split("\n").filter(l => l.trim())) {
      const parts = line.split("|");
      if (parts.length >= 4) {
        const name = parts[0].trim();
        const bt = parseFloat(parts[2].trim()) || 0;
        const eq = parseFloat(parts[3].trim()) || 0;
        console.log(`    ${((bt + eq) / 1e6).toFixed(1)}M EUR (transfers: ${(bt / 1e6).toFixed(1)}M, equity: ${(eq / 1e6).toFixed(1)}M) — ${name}`);
      }
    }
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
