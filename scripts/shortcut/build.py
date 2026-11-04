"""Builds L4.plist, the unsigned source of the iPhone Shortcut. Signing needs a Mac:

  python3 scripts/shortcut/build.py /tmp/L4.plist
  cp /tmp/L4.plist /tmp/L4-unsigned.shortcut
  shortcuts sign --mode anyone --input /tmp/L4-unsigned.shortcut --output public/L4.shortcut

One signed file serves every Server: it holds no link, and asks for one when it is added.
"""
import plistlib
import sys
import uuid

upload_uuid = str(uuid.uuid4()).upper()


workflow = {
    "WFWorkflowClientVersion": "2607.0.2",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59511},
    "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowInputContentItemClasses": ["WFAVAssetContentItem", "WFImageContentItem", "WFGenericFileContentItem"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowImportQuestions": [
        {
            "ActionIndex": 0,
            "Category": "Parameter",
            "ParameterKey": "WFURL",
            "Text": "Paste your link. Make one in your Server's Settings, under Connections.",
            "DefaultValue": "",
        },
    ],
    "WFWorkflowActions": [
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
            "WFWorkflowActionParameters": {
                "UUID": upload_uuid,
                "WFURL": "",
                "WFHTTPMethod": "POST",
                "WFHTTPBodyType": "File",
                "WFRequestVariable": {"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"},
            },
        },
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.openurl",
            "WFWorkflowActionParameters": {
                "WFInput": {
                    "Value": {"OutputUUID": upload_uuid, "OutputName": "Contents of URL", "Type": "ActionOutput"},
                    "WFSerializationType": "WFTextTokenAttachment",
                }
            },
        },
    ],
}

with open(sys.argv[1] if len(sys.argv) > 1 else "L4.plist", "wb") as f:
    plistlib.dump(workflow, f, fmt=plistlib.FMT_BINARY)
