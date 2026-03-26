// models/Project.js
import mongoose from "mongoose";

const projectSchema = new mongoose.Schema({

    projectId: {
        type: String,
        required: true,
        unique: true
    },

    projectName: {
        type: String,
        required: true
    },

    websiteUrl: {
        type: String,
        required: true
    },

    companyUrl: {
        type: String
    },

    /* -------------------------
       Dynamic Collection Names
       ------------------------- */
    collections: {
        supportUsers: {
            type: String,
            required: true
        },
        metadata: {
            type: String,
            required: true
        },
        messages: {
            type: String,
            required: true
        }
    },

    /* -------------------------
       Widget Configuration
       ------------------------- */
    widgetConfig: {
        theme: {
            type: String,
            enum: ["modern", "classic", "minimal", "bold"],
            default: "modern"
        },
        primaryColor: {
            type: String,
            default: "#4f46e5"
        },
        headerTextColor: {
            type: String,
            default: "#ffffff"
        },
        headerText: {
            type: String,
            default: "Talk with Support! 👋"
        },
        productNameSize: {
            type: String,
            default: "12"
        },
        productNameX: {
            type: String,
            default: "0"
        },
        productNameY: {
            type: String,
            default: "0"
        },
        position: {
            type: String,
            enum: ["bottom-right", "bottom-left", "top-right", "top-left"],
            default: "bottom-right"
        },
        logoUrl: {
            type: String
        },
        supportLogoUrl: {
            type: String
        },
        welcomeMessage: {
            type: String,
            default: "Hi 👋 How can we help you?"
        },
        companyName: {
            type: String
        },
        logoParams: {
            x: { type: String, default: "0" },
            y: { type: String, default: "0" },
            size: { type: String, default: "64" }
        }
    },

    /* -------------------------
       Email Settings
       ------------------------- */
    emailSetting: {
        collectEmails: {
            type: Boolean,
            default: false
        },
        emailMessage: {
            type: String
        },
        isEmailMandatory: {
            type: Boolean,
            default: false
        },
        deleteSkippedAfterDays: {
            type: Number,
            default: 3
        }
    },

    /* -------------------------
       Snippets
       ------------------------- */
    snippets: {
        studentSideWidget: {
            type: String // <script>...</script>
        }
    },

    /* -------------------------
       Review Settings
       ------------------------- */
    reviewConfig: {
        enabled: {
            type: Boolean,
            default: true
        },
        message: {
            type: String,
            default: ""
        }
    }

}, {
    timestamps: true
});

export default mongoose.model("Project", projectSchema);
