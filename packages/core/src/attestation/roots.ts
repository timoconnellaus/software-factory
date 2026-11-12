// Google's hardware attestation root keys (ADR 0541 decision 3), pinned by their public keys, not
// by certificate: Google has re-issued the RSA root's certificate several times with the same key
// (2016, 2019, 2021, 2022), and a chain may end in any of them. Taken on 2026-11-12 from
// https://developer.android.com/privacy-and-security/security-key-attestation#root_certificate
// ("Root certificates"). When Google rotates, add the new key here; a test runs a captured real
// chain against this list.
//
// Each entry is the DER SubjectPublicKeyInfo, base64, and its SHA-256 (hex) for the log.
export interface PinnedRoot {
  name: string;
  /** SHA-256 of the DER SubjectPublicKeyInfo, hex: what a chain's last key must hash to. */
  spkiSha256: string;
  /** The DER SubjectPublicKeyInfo, base64. */
  spki: string;
}

export const GOOGLE_ATTESTATION_ROOTS: readonly PinnedRoot[] = [
  {
    name: "Google Hardware Attestation Root (RSA 4096, serialNumber=f92009e853b6b045)",
    spkiSha256: "feb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae",
    spki:
      "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdSSxtf" +
      "6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7tv0Sk3iiKkypnEUtR6WfMgH0QZfK" +
      "HM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggjnar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB" +
      "/M0n1n/W9nGqC4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQoVJYnFPlXTcH" +
      "YvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+OJtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7" +
      "+DVagf7quvmag8jfPioyKvxnK/EgsTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504L" +
      "zSRiigHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+MRPjy02i59lINMRRev56G" +
      "Ktcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9EaDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+" +
      "NpUFgNPN9PvQi8WEg5UmAGMCAwEAAQ==",
  },
  {
    name: "Google Key Attestation CA1 (ECDSA P-384, from 2026)",
    spkiSha256: "3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec",
    spki:
      "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEI9ojcU7fPlsFCjxy6IRqzgeOoK0b+YsV9FPQywiyw8EQRTkJ9u3qwfnI" +
      "4DGoSLlBqClTXJfgfCcZvs60FikNMHnu4fkRzObfgDkU2KNXezT9/RQ+XvNslxPHrHCowhGr",
  },
];
