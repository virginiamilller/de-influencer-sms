export default function SmsPage() {
  return (
    <main style={{ maxWidth: 640, margin: '40px auto', padding: 24, fontFamily: 'system-ui, sans-serif', lineHeight: 1.6 }}>
      <h1>De-Influencer SMS</h1>
      <p>
        About to impulse buy something? Text us first. We&apos;ll roast it (kindly)
        and help you think twice 😅.
      </p>

      <h2>How to sign up</h2>
      <p>
        Text <strong>START</strong> to <strong>(206) 741-0805</strong> to opt in.
      </p>

      <h2>What you&apos;ll get</h2>
      <p>
        After opting in, text us anything you&apos;re thinking of buying — words, a photo,
        or both. We reply with an AI-generated take on whether you actually need it,
        plus a practical alternative (borrow, rent, skip). You only get messages in
        response to ones you send.
      </p>

      <h2>The fine print</h2>
      <ul>
        <li>Message frequency varies based on your messages.</li>
        <li>Msg &amp; data rates may apply.</li>
        <li>Reply <strong>STOP</strong> to unsubscribe at any time.</li>
        <li>Reply <strong>HELP</strong> for help, or email{' '}
          <a href="mailto:virginia@virginiamiller.com">virginia@virginiamiller.com</a>.
        </li>
        <li>We do not share your phone number with third parties.</li>
      </ul>

      <p>
        See our <a href="/privacy">Privacy Policy</a> and{' '}
        <a href="/terms">Terms &amp; Conditions</a>.
      </p>

      <p style={{ fontSize: 14, color: '#666', marginTop: 40 }}>
        De-Influencer SMS is a personal hobby project.
      </p>
    </main>
  );
}
