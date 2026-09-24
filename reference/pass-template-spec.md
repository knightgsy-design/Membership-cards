# Pass template specification

## Front of card
| Field key | Label on card | Source column |
|---|---|---|
| memberName | Member | memberName |
| membershipType | Membership | membershipType |
| validTo | Valid to | validTo |
| memberNumber | Member no. | memberNumber |
| (barcode) | QR code | memberNumber |
| season | Header, top right | season |
| photo | Photo | Optional; added by member via Passcreator landing page |

## Back of card
| Field | Content |
|---|---|
| Latest from the club | Notice field, edited by hand. Change message set so edits notify members. |
| At the club | Show this card at the bar for member prices, and at the door for member-only events. |
| Manage my membership | Link to Sailing Club Manager member portal |
| Book club events | Link to events page |
| Club website | Link to club website |
| Contact | Guernsey Yacht Club, Castle Emplacement, St Peter Port · [CLUB PHONE] · [CLUB EMAIL] |
| Terms | Personal to the named member and not transferable. |

## Expiry
- Pass expiry = passExpiry (ISO date).
- On renewal, the same pass updates (validTo, passExpiry, season). Members never re-download.

Field keys must be confirmed against the template once built in Passcreator.
