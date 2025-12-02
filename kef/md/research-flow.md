## SafeInsights Research Workflow

```mermaid
---
config:
      theme: redux
---
flowchart TD
    A["Discover SafeInsights<br > via colleagues, conferences, marketing"]
    B["Explore Knowledge Base:<br > datasets, data orgs (DO)s, requirements, costs"]
    C["Create researcher profile"]
    C2["Create/Edit/Revise study proposal"]
    C3["Submit to DO via SI app"]
    D["DO reviews proposal<br >(feasibility, impact, qualifications)"]
    E{"Proposal approved?"}
    FB1["DO gives feedback"]
    F["Finish agreements <br > Complete SI and DO requirements"]
    RV1{Review needed?}

    H1["Develop analysis code"]
    H2["Launch CRATE-R<br >to develop and test code with sample data and AI"]
    I["Submit code to DO"]
    J["DO reviews code with assistance from CRATE-DO"]
    K{"Code approved?"}
    L1["Package code for DO Enclave"]
    FB2["DO gives feedback"]
    L2["Run code in DO enclave<br >Encrypt and return outputs"]
    L3["DO Reviewer decrypts and reviews output"]
    M{"Outputs approved?"}
    N["Researcher receives approved results"]
    
    P{"Research complete?"}
    Q[Study Complete <br > Details and Metrics Saved]

    IP["Payment and invoicing workflow are not yet integrated"]
    INV["DO invoices research lab"]
    PAY["Research Lab pays"]

    %% --- Legend ---
    subgraph Key[Legend]
        RES["👤 Researcher Action"]
        REV["👤 Data Org Reviewer (DO) Action"]
        SIP["SafeInsights (SI) Platform Step"]
        DOE[Data Org Enclave Step]
        %%CRT-R["CRATE: Coding, Reviewing, and Testing Environment <br >CRATE-R: CRATE for Researchers <br >CRATE-DO: CRATE for Data Orgs"]
        %%DEC{Decision Point}
    end
    %% --- Abbreviations ---
    %%subgraph AB[Abbreviations]
      %%  DO["DO: Data Organization"]
      %%  SI["SI: SafeInsights"]
      %%  CRATE["CRATE: Coding, Reviewing, and Testing Environment <br >CRATE-R: CRATE for Researchers <br >CRATE-DO: CRATE for Data Orgs"]
        %%DEC{Decision Point}
   %% end
    %% --- Abbreviations ---
    ABBR["Abbreviations<br >]DO: Data Organization<br >SI: SafeInsights<br > CRATE: Coding, Reviewing, and Testing Environment <br >CRATE-R: CRATE for Researchers <br >CRATE-DO: CRATE for Data Orgs"]
        %%DEC{Decision Point}

    %% --- Actor classes ---
    classDef researcher fill:#D0E6FF,stroke:#005BBB,stroke-width:1px;
    classDef dataorg fill:#FFE2CC,stroke:#C55A11,stroke-width:1px;
    classDef enclave fill:#D2F2F0,stroke:#2A7F7B,stroke-width:1px;
    classDef enclave fill:#E7E2FF,stroke:#5A51C3,stroke-width:1px;
    classDef safeinsights fill:#E2F0D9,stroke:#38761D,stroke-width:1px;
    classDef decision fill:#FFF2CC,stroke:#B7A100,stroke-width:2px;

    class RES researcher;
    class REV dataorg;
    class DOE enclave;
    class SIP safeinsights;
    class DEC decision;
    
    %% --- Assign nodes ---
    class A,B,C,C2,C3,F,H1,H2,I,N,PAY researcher;
    class D,G,J,L3,FB1,FB2,INV dataorg;
    class E,K,M,P,RV1 decision;
    class L1,Q safeinsights;
    class L2 enclave;

    %% Main proposal flow
    A --> B --> C --> C2 --> C3 --> D --> E
    E -->|Approved| F --> RV1  
    E -->|Changes Needed| FB1 --> C2
    RV1 -->|No| H1 --> H2
    RV1 -->|Yes| D
   %% E -->[Proposal Rejected] --> Q
   
    %% Optional additional proposal flow


    %% Code development & review
    H2 --> I --> J --> K
    K -->|Approved| L1 --> L2 --> L3 --> M
    K -->|Changes needed| FB2 --> H1

    %% Output review
    M -->|Yes| N
    M -->|No| FB2

    %% Post-results & repeat loop
    N --> P
    P -->|Yes| Q
    P -->|No| H1

    %% Payment flow
    IP --> INV --> PAY
    
