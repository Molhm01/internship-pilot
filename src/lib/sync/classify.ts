// Heuristic, fully-local classification of a discovered internship posting.
// Nothing here calls out to any geocoding/NLP service — it's keyword
// matching plus a small hardcoded city table, so results are best-effort
// and clearly documented as such in the UI, never presented as certain.

export const DISCIPLINE_TAGS = [
  "software",
  "electrical",
  "computerEngineering",
  "mechanical",
  "aerospace",
  "civil",
  "chemical",
  "biomedical",
  "industrial",
  "materials",
  "powerEnergy",
  "mechatronics",
  "hardware",
  "embedded",
  "electronics",
  "test",
  "manufacturing",
  "semiconductor",
  "fpga",
  "controls",
  "robotics",
  "systemsEngineering",
  "engineeringTechnician",
  "fieldApplications",
  "firmware",
] as const;
export type DisciplineTag = (typeof DISCIPLINE_TAGS)[number];

const DISCIPLINE_KEYWORDS: Record<DisciplineTag, string[]> = {
  software: [
    "software engineer",
    "software engineering",
    "software developer",
    "application developer",
    "application engineer",
    "full stack engineer",
    "full-stack engineer",
    "frontend engineer",
    "front-end engineer",
    "backend engineer",
    "back-end engineer",
    "cloud engineer",
    "site reliability engineer",
    "sre intern",
  ],
  electrical: [
    "electrical engineer",
    "electrical engineering",
    "power electronics",
    "circuit design",
    " ee intern",
  ],
  computerEngineering: [
    "computer engineer",
    "computer engineering",
    "computer hardware",
    "soc design",
    "vlsi",
  ],
  mechanical: [
    "mechanical engineer",
    "mechanical engineering",
    "mechanical design",
    "thermal engineer",
    "thermal engineering",
    "fluid dynamics",
    "cfd engineer",
  ],
  aerospace: [
    "aerospace engineer",
    "aerospace engineering",
    "aeronautical engineer",
    "aeronautical engineering",
    "flight systems",
    "flight test engineer",
    "propulsion engineer",
    "space systems engineer",
  ],
  civil: [
    "civil engineer",
    "civil engineering",
    "structural engineer",
    "structural engineering",
    "transportation engineer",
    "geotechnical engineer",
    "water resources engineer",
  ],
  chemical: [
    "chemical engineer",
    "chemical engineering",
    "process engineering",
    "process development engineer",
  ],
  biomedical: [
    "biomedical engineer",
    "biomedical engineering",
    "bioengineer",
    "bioengineering",
    "medical device engineer",
  ],
  industrial: [
    "industrial engineer",
    "industrial engineering",
    "operations engineer",
    "operations engineering",
    "continuous improvement engineer",
  ],
  materials: [
    "materials engineer",
    "materials engineering",
    "metallurgical engineer",
    "metallurgy",
    "polymer engineer",
  ],
  powerEnergy: [
    "power engineer",
    "power engineering",
    "power systems",
    "energy engineer",
    "energy engineering",
    "grid engineer",
    "substation engineer",
  ],
  mechatronics: [
    "mechatronics engineer",
    "mechatronics engineering",
    "electromechanical engineer",
    "electro-mechanical engineer",
  ],
  hardware: ["hardware engineer", "hardware engineering", "pcb design", "digital design", "asic"],
  embedded: ["embedded systems", "embedded software", "embedded engineer", "rtos", "microcontroller"],
  electronics: ["electronics engineer", "electronic design", "analog circuit", "analog design"],
  test: ["test engineer", "test engineering", "validation engineer", "quality engineer", "qa engineer"],
  manufacturing: ["manufacturing engineer", "manufacturing engineering", "process engineer", "production engineer"],
  semiconductor: ["semiconductor", "fab engineer", "wafer fab", "chip design", "silicon engineer"],
  fpga: ["fpga", "digital hardware", "verilog", "vhdl", "hdl design"],
  controls: ["controls engineer", "control systems engineer", "automation engineer", "plc programming", "scada"],
  robotics: ["robotics engineer", "robotics intern", "autonomous systems", "motion control"],
  systemsEngineering: ["systems engineer", "systems engineering", "requirements engineering"],
  engineeringTechnician: ["engineering technician", "engineering tech intern", "lab technician"],
  fieldApplications: ["field applications engineer", "field application engineer", "fae intern"],
  firmware: ["firmware engineer", "firmware intern", "firmware development"],
};

export const STUDENT_ROLE_PATTERN = /\b(intern(ship)?s?|co-?ops?|undergrad(uate)?)\b/i;

// Used by nationwide ATS discovery to decide if a posting is worth ingesting
// at all. Requires BOTH a target engineering discipline AND explicit
// internship/co-op/undergraduate language in the title — a company's full
// list of open (full-time) engineering roles must never be pulled in as
// "internships" just because the discipline keywords match.
export function isTargetEngineeringRole(title: string, description: string): boolean {
  if (!STUDENT_ROLE_PATTERN.test(title)) return false;
  return classifyDisciplines(title, description).length > 0;
}

export function classifyDisciplines(title: string, description: string): DisciplineTag[] {
  const text = `${title} ${description}`.toLowerCase();
  return DISCIPLINE_TAGS.filter((tag) => DISCIPLINE_KEYWORDS[tag].some((kw) => text.includes(kw)));
}

export function classifySeason(internshipTerm: string | null | undefined): string {
  if (!internshipTerm) return "Unknown";
  const t = internshipTerm.toLowerCase();
  if (t.includes("summer")) return "Summer";
  if (t.includes("fall")) return "Fall";
  if (t.includes("spring")) return "Spring";
  if (t.includes("winter")) return "Winter";
  return "Unknown";
}

export function classifySophomoreEligible(description: string): boolean | null {
  const text = description.toLowerCase();
  if (text.includes("sophomore")) return true;
  if (
    /\b(junior|rising junior)s?\s+(and|or)\s+seniors?\s+only\b/.test(text) ||
    /\bmust be a (rising )?(junior|senior)\b/.test(text) ||
    text.includes("juniors and seniors only")
  ) {
    return false;
  }
  return null;
}

export function classifyGraduationYears(description: string): number[] {
  const years = new Set<number>();
  const patterns = [/class of (20\d{2})/gi, /graduat\w*\s+(?:in\s+)?(20\d{2})/gi];
  for (const pattern of patterns) {
    for (const match of description.matchAll(pattern)) {
      const year = parseInt(match[1], 10);
      if (year >= 2024 && year <= 2032) years.add(year);
    }
  }
  return Array.from(years).sort();
}

export function classifySponsorship(h1bSponsored: string | null | undefined): string {
  if (!h1bSponsored) return "Unknown";
  const v = h1bSponsored.trim().toLowerCase();
  if (v === "yes") return "Yes";
  if (v === "no") return "No";
  if (v.includes("not sure")) return "NotSure";
  return "Unknown";
}

const CITIZENSHIP_CLEARANCE_KEYWORDS = [
  "u.s. citizen",
  "us citizen",
  "united states citizen",
  "security clearance",
  "secret clearance",
  "top secret",
  "itar",
  "export control",
  "export-controlled",
];

export function classifyCitizenshipOrClearance(description: string): boolean {
  const text = description.toLowerCase();
  return CITIZENSHIP_CLEARANCE_KEYWORDS.some((kw) => text.includes(kw));
}

export function parseCompensation(salary: string | null | undefined): { min: number | null; max: number | null } {
  if (!salary || salary.trim().toUpperCase() === "N/A") return { min: null, max: null };
  const match = salary.match(/\$?([\d.]+)\s*-\s*\$?([\d.]+)/);
  if (!match) return { min: null, max: null };
  const min = parseFloat(match[1]);
  const max = parseFloat(match[2]);
  if (Number.isNaN(min) || Number.isNaN(max)) return { min: null, max: null };
  return { min, max };
}

// A small hardcoded lat/lng table of US cities — enough to cover the tri-state
// area precisely and most major national tech/engineering hubs. This is NOT a
// geocoding service: any city not in this table yields a null (unknown)
// distance rather than a guess. Keys are lowercased "city, state" pairs.
const CITY_COORDS: Record<string, [number, number]> = {
  "clifton, nj": [40.8584, -74.1638],
  "newark, nj": [40.7357, -74.1724],
  "jersey city, nj": [40.7178, -74.0431],
  "paterson, nj": [40.9168, -74.1718],
  "elizabeth, nj": [40.6639, -74.2107],
  "edison, nj": [40.5187, -74.4121],
  "new brunswick, nj": [40.4862, -74.4518],
  "hoboken, nj": [40.744, -74.0324],
  "montclair, nj": [40.826, -74.209],
  "princeton, nj": [40.3573, -74.6672],
  "morristown, nj": [40.7968, -74.4815],
  "trenton, nj": [40.2206, -74.7597],
  "camden, nj": [39.9259, -75.1196],
  "hackensack, nj": [40.8859, -74.0435],
  "new york, ny": [40.7128, -74.006],
  "brooklyn, ny": [40.6782, -73.9442],
  "queens, ny": [40.7282, -73.7949],
  "bronx, ny": [40.8448, -73.8648],
  "staten island, ny": [40.5795, -74.1502],
  "yonkers, ny": [40.9312, -73.8988],
  "white plains, ny": [41.034, -73.7629],
  "stamford, ct": [41.0534, -73.5387],
  "greenwich, ct": [41.0262, -73.6282],
  "philadelphia, pa": [39.9526, -75.1652],
  "conshohocken, pa": [40.0787, -75.3016],
  "pittsburgh, pa": [40.4406, -79.9959],
  "cincinnati, oh": [39.1031, -84.5121],
  "littleton, co": [39.6133, -105.0166],
  "los angeles, ca": [34.0522, -118.2437],
  "portsmouth, va": [36.8354, -76.2983],
  "lafayette, la": [30.2241, -92.0198],
  "cupertino, ca": [37.323, -122.0322],
  "vance, al": [33.1596, -87.2472],
  "boston, ma": [42.3601, -71.0589],
  "asheville, nc": [35.5951, -82.5515],
  "arlington, va": [38.8816, -77.091],
  "thompsons, tx": [29.5305, -95.5344],
  "fremont, ca": [37.5485, -121.9886],
  "seattle, wa": [47.6062, -122.3321],
  "gainesville, va": [38.7959, -77.6438],
  "houston, tx": [29.7604, -95.3698],
  "covington, la": [30.4755, -90.1009],
  "houma, la": [29.5958, -90.7195],
  "sarasota, fl": [27.3364, -82.5307],
  "riverside, ca": [33.9806, -117.3755],
  "san francisco, ca": [37.7749, -122.4194],
  "san jose, ca": [37.3382, -121.8863],
  "santa clara, ca": [37.3541, -121.9552],
  "mountain view, ca": [37.3861, -122.0839],
  "palo alto, ca": [37.4419, -122.143],
  "austin, tx": [30.2672, -97.7431],
  "dallas, tx": [32.7767, -96.797],
  "chicago, il": [41.8781, -87.6298],
  "atlanta, ga": [33.749, -84.388],
  "denver, co": [39.7392, -104.9903],
  "phoenix, az": [33.4484, -112.074],
  "san diego, ca": [32.7157, -117.1611],
  "portland, or": [45.5152, -122.6784],
  "detroit, mi": [42.3314, -83.0458],
  "washington, dc": [38.9072, -77.0369],
  "charlotte, nc": [35.2271, -80.8431],
  "raleigh, nc": [35.7796, -78.6382],
  "nashville, tn": [36.1627, -86.7816],
  "miami, fl": [25.7617, -80.1918],
  "orlando, fl": [28.5383, -81.3792],
  "minneapolis, mn": [44.9778, -93.265],
};

function normalizeLocationKey(location: string): string | null {
  // Handles "City, ST, United States" and "Multi Locations: City, ST, ...; ..."
  let loc = location.replace(/^multi locations?:\s*/i, "");
  loc = loc.split(";")[0].trim();
  const match = loc.match(/^([^,]+),\s*([A-Za-z]{2})\b/);
  if (!match) return null;
  return `${match[1].trim().toLowerCase()}, ${match[2].trim().toLowerCase()}`;
}

const CLIFTON_NJ: [number, number] = CITY_COORDS["clifton, nj"];

function haversineMiles(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return R * 2 * Math.asin(Math.sqrt(h));
}

export function distanceFromCliftonMiles(location: string | null | undefined): number | null {
  if (!location) return null;
  const key = normalizeLocationKey(location);
  if (!key || !CITY_COORDS[key]) return null;
  return Math.round(haversineMiles(CLIFTON_NJ, CITY_COORDS[key]) * 10) / 10;
}
